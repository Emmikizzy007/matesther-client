import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/lib/password";

const VALID_ROLES = ["OWNER", "PRODUCTION_MANAGER", "WORKER"];

function safe(u: typeof users.$inferSelect) {
  const { passwordHash: _omit, ...rest } = u;
  return { ...rest, hasPassword: !!u.passwordHash };
}

/** List all staff users (passwords never returned) */
export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const rows = await db.select().from(users);
    return NextResponse.json(rows.map(safe));
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/** Create a staff user (owner creates production managers / workers) */
export async function POST(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const b = await req.json();
    if (!b.name) return NextResponse.json({ error: "Name is required." }, { status: 400 });
    if (!b.email) return NextResponse.json({ error: "Email is required." }, { status: 400 });
    if (!b.password || String(b.password).length < 6)
      return NextResponse.json(
        { error: "Password is required (minimum 6 characters)." },
        { status: 400 }
      );
    if (!VALID_ROLES.includes(b.role))
      return NextResponse.json({ error: "Choose a valid role." }, { status: 400 });

    const [row] = await db
      .insert(users)
      .values({
        organizationId: 1,
        name: b.name,
        email: String(b.email).trim().toLowerCase(),
        passwordHash: hashPassword(String(b.password)),
        role: b.role,
        phone: b.phone || null,
        status: "ACTIVE",
      })
      .returning();
    return NextResponse.json(safe(row), { status: 201 });
  } catch (e: any) {
    const msg = String(e.message || "");
    if (msg.includes("unique") || msg.includes("duplicate"))
      return NextResponse.json(
        { error: "That email is already used by another staff account." },
        { status: 400 }
      );
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Update a staff user - name, role, phone, status, and/or new password */
export async function PUT(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "User id is required." }, { status: 400 });
    const [target] = await db.select().from(users).where(eq(users.id, Number(b.id)));
    if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
    if (target.role === "OWNER" && target.status === "ACTIVE" &&
        (b.role && b.role !== "OWNER" || b.status && b.status !== "ACTIVE")) {
      const allOwners = await db.select().from(users).where(eq(users.role, "OWNER"));
      if (allOwners.filter((account) => account.status === "ACTIVE").length <= 1)
        return NextResponse.json({ error: "Keep at least one active Owner account." }, { status: 409 });
    }
    const patch: Partial<typeof users.$inferInsert> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.phone !== undefined) patch.phone = b.phone || null;
    if (b.role !== undefined) {
      if (!VALID_ROLES.includes(b.role))
        return NextResponse.json({ error: "Choose a valid role." }, { status: 400 });
      patch.role = b.role;
    }
    if (b.status !== undefined) patch.status = b.status;
    if (b.password) {
      if (String(b.password).length < 6)
        return NextResponse.json(
          { error: "New password must be at least 6 characters." },
          { status: 400 }
        );
      patch.passwordHash = hashPassword(String(b.password));
    }
    const [row] = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, Number(b.id)))
      .returning();
    if (!row) return NextResponse.json({ error: "User not found." }, { status: 404 });
    return NextResponse.json(safe(row));
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/** Delete a staff user (cannot delete the last owner) */
export async function DELETE(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get("id"));
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
    if (target.role === "OWNER" && target.status === "ACTIVE") {
      const owners = await db.select().from(users).where(eq(users.role, "OWNER"));
      if (owners.filter((account) => account.status === "ACTIVE").length <= 1)
        return NextResponse.json(
          { error: "Cannot delete the last active Owner account." },
          { status: 409 }
        );
    }
    await db.delete(users).where(eq(users.id, id));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
