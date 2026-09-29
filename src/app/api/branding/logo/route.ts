import { NextResponse } from "next/server";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { guard, OWNER } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;
const ICON_SIZES = [48, 180, 192, 512];

function actualMime(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Public branding only. Original bytes are served untouched unless requesting an OS icon. */
export async function GET(req: Request) {
  try {
    const [org] = await db
      .select({ logoData: organizations.logoData, logoMime: organizations.logoMime })
      .from(organizations)
      .where(eq(organizations.id, 1))
      .limit(1);
    if (!org?.logoData || !org.logoMime) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    const original = Buffer.from(org.logoData, "base64");
    const requested = new URL(req.url).searchParams.get("size");
    const size = requested ? Number(requested) : null;
    if (requested && (!Number.isInteger(size) || !ICON_SIZES.includes(size!)))
      return NextResponse.json({ error: "Unsupported icon size" }, { status: 400 });

    // Favicon / installed-app icons need square dimensions; fit and pad the same
    // original file without cropping, replacing, or redrawing its artwork.
    const bytes = size
      ? await sharp(original).rotate().resize(size, size, { fit: "contain", background: "#000000" }).png().toBuffer()
      : original;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": size ? "image/png" : org.logoMime,
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Unable to serve Matesther branding", error);
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

/** Owner uploads the exact PNG/JPEG/WebP file; it is persisted in PostgreSQL. */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const form = await req.formData();
    const file = form.get("logo");
    if (!file || typeof file === "string")
      return NextResponse.json({ error: "Choose the original Matesther image file." }, { status: 400 });
    if (file.size > MAX_BYTES || file.size === 0)
      return NextResponse.json({ error: "The logo must be an image smaller than 2 MB." }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = actualMime(bytes);
    if (!mime) return NextResponse.json({ error: "Upload the original PNG, JPG or WebP image - not an SVG or screenshot of the page." }, { status: 400 });
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height || metadata.width < 512 || metadata.height < 512)
      return NextResponse.json({ error: "For a phone app icon, use the original high-resolution image (at least 512 × 512 pixels)." }, { status: 400 });
    const [org] = await db
      .update(organizations)
      .set({ logoData: bytes.toString("base64"), logoMime: mime })
      .where(eq(organizations.id, 1))
      .returning({ id: organizations.id });
    if (!org) return NextResponse.json({ error: "Set up the Owner account before uploading the logo." }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Logo upload failed", error);
    return NextResponse.json({ error: "Could not save your logo. Try the original image file again." }, { status: 500 });
  }
}
