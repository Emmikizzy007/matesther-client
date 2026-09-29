import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { organizations, users } from "@/db/schema";

export async function GET(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const [orgRows, userRows] = await Promise.all([
      db.select().from(organizations).where(eq(organizations.id, 1)).limit(1),
      db.select({
        id: users.id, name: users.name, email: users.email,
        role: users.role, phone: users.phone, status: users.status,
      }).from(users),
    ]);
    const org = orgRows[0];
    // Never send password hashes or the original base64 image in JSON.
    return NextResponse.json({
      org: org ? {
        id: org.id, name: org.name, phone: org.phone, email: org.email,
        address: org.address, logoConfigured: !!org.logoData,
      } : null,
      users: userRows,
    });
  } catch (error) {
    console.error("Business profile read failed", error);
    return NextResponse.json({ error: "Unable to load business settings." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    if (!String(body.name ?? "").trim())
      return NextResponse.json({ error: "Business name is required." }, { status: 400 });
    const [row] = await db.update(organizations).set({
      name: String(body.name).trim(),
      phone: String(body.phone ?? "").trim() || null,
      email: String(body.email ?? "").trim() || null,
      address: String(body.address ?? "").trim() || null,
    }).where(eq(organizations.id, 1)).returning({ id: organizations.id, name: organizations.name });
    if (!row) return NextResponse.json({ error: "Finish first-owner setup before editing Matesther." }, { status: 404 });
    return NextResponse.json(row);
  } catch (error) {
    console.error("Business profile save failed", error);
    return NextResponse.json({ error: "Unable to save business settings." }, { status: 500 });
  }
}
