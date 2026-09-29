import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { organizations, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";

function keysMatch(input: string, expected: string): boolean {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(input), hash(expected));
}

/**
 * Bootstrap a brand-new database exactly once. A private Netlify environment
 * variable prevents a stranger from claiming the first owner account.
 */
export async function POST(req: Request) {
  const setupKey = process.env.MATESTHER_SETUP_KEY;
  if (!setupKey)
    return NextResponse.json(
      { error: "First-time setup is disabled. Set MATESTHER_SETUP_KEY on the new Netlify site." },
      { status: 503 }
    );

  try {
    const input = await req.json();
    const name = String(input.name ?? "").trim();
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    const providedKey = String(input.setupKey ?? "");
    if (!keysMatch(providedKey, setupKey))
      return NextResponse.json({ error: "Incorrect private setup key." }, { status: 403 });
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12)
      return NextResponse.json(
        { error: "Enter a name, valid email and a password of at least 12 characters." },
        { status: 400 }
      );

    // Serialise simultaneous requests so only one first Owner can be created.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(667877001)`);
      const existing = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing.length) throw new Error("ALREADY_SETUP");

      // The rest of this single-organisation ERP uses organisation id 1.
      await tx.insert(organizations).values({
        id: 1,
        name: "Matesther",
        phone: "08072611499",
        email,
        address: "Zone 7 behind Capital Hotel, Osogbo, Osun, Nigeria",
      }).onConflictDoNothing();
      await tx.execute(sql`SELECT setval(pg_get_serial_sequence('organizations', 'id'), GREATEST((SELECT MAX(id) FROM organizations), 1))`);
      await tx.insert(users).values({
        organizationId: 1,
        name,
        email,
        passwordHash: hashPassword(password),
        role: "OWNER",
        status: "ACTIVE",
      });
    });

    return NextResponse.json({ ok: true, message: "Owner created. Sign in to Matesther." }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_SETUP")
      return NextResponse.json(
        { error: "Matesther is already set up. Use the normal sign-in form." },
        { status: 409 }
      );
    console.error("First owner setup failed", error);
    return NextResponse.json(
      { error: "Setup couldn't complete. Verify the new Supabase database and schema-only SQL." },
      { status: 500 }
    );
  }
}
