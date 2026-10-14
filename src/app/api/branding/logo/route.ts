import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const BUNDLED_LOGO_PATH = join(process.cwd(), "public", "matesther-logo.png");
let bundledLogoCache: Buffer | null | undefined;

/** Bounded memo for the derived OS icons, keyed by source hash + size. */
const iconMemo = new Map<string, Promise<Buffer>>();
function iconCache(key: string, produce: () => Promise<Buffer>): Promise<Buffer> {
  const hit = iconMemo.get(key);
  if (hit) return hit;
  const made = produce();
  iconMemo.set(key, made);
  if (iconMemo.size > 8) iconMemo.delete(iconMemo.keys().next().value as string);
  return made;
}

/**
 * The official MATESTHER mark committed to `public/matesther-logo.png`. It is
 * used only while the Owner has not uploaded their own logo through Settings,
 * and is served exactly as committed - never redrawn or re-rendered. `process
 * .cwd()` is the project root under `next dev`, `next start` and this test
 * suite, so the same file is resolved everywhere.
 */
function bundledLogo(): Buffer | null {
  if (bundledLogoCache !== undefined) return bundledLogoCache;
  try {
    bundledLogoCache = readFileSync(BUNDLED_LOGO_PATH);
  } catch {
    bundledLogoCache = null;
  }
  return bundledLogoCache;
}

/** Public branding only. Original bytes are served untouched unless requesting an OS icon. */
export async function GET(req: Request) {
  try {
    const [org] = await db
      .select({ logoData: organizations.logoData, logoMime: organizations.logoMime })
      .from(organizations)
      .where(eq(organizations.id, 1))
      .limit(1);
    const requested = new URL(req.url).searchParams.get("size");
    const size = requested ? Number(requested) : null;
    if (requested && (!Number.isInteger(size) || !ICON_SIZES.includes(size!)))
      return NextResponse.json({ error: "Unsupported icon size" }, { status: 400 });

    // The Owner's own uploaded logo always wins. While none is set, fall back to
    // the official mark committed to public/matesther-logo.png so every slot -
    // sidebar, login, letterhead, favicon and the PWA icons - shows the real logo
    // with no database write at all.
    const hasUpload = Boolean(org?.logoData && org.logoMime);
    const original = hasUpload ? Buffer.from(org!.logoData!, "base64") : bundledLogo();
    if (!original) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    const mime = hasUpload ? org!.logoMime! : "image/png";

    // Content identity for cheap revalidation: the logo bytes only change when
    // the Owner uploads a new file, so a hash of the source is a stable ETag.
    const etag = `"${createHash("sha1").update(original).digest("hex").slice(0, 20)}"`;
    const versioned = new URL(req.url).searchParams.has("v");
    if (!versioned && req.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "public, max-age=60" } });

    // Favicon / installed-app icons need square dimensions; fit and pad the same
    // original file without cropping, replacing, or redrawing its artwork.
    // The result is memoised per (source, size): the expensive sharp pass then
    // runs once per logo version instead of once per request.
    const bytes = size
      ? await iconCache(`${etag}:${size}`, () =>
          sharp(original).rotate().resize(size, size, { fit: "contain", background: "#000000" }).png().toBuffer()
        )
      : original;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": size ? "image/png" : mime,
        // The logo was previously served no-store, so every page load (the
        // sidebar shows it everywhere) re-downloaded the full image. A
        // versioned URL (?v=..., used by Settings after an upload) is now
        // immutable; bare URLs cache briefly and revalidate via ETag.
        "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=60",
        ETag: etag,
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
