import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";

/** Public endpoint; only tells the login page if first-time setup is needed. */
export async function GET() {
  try {
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    return NextResponse.json(
      { hasUsers: existing.length > 0, setupReady: !!process.env.MATESTHER_SETUP_KEY },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Account status check failed", error);
    return NextResponse.json(
      { error: "Couldn't reach the database. Check DATABASE_URL and run the schema-only setup." },
      { status: 503 }
    );
  }
}
