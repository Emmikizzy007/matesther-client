import { NextResponse } from "next/server";
import { db } from "@/db";
import { sessions, users, workers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashSessionToken, readSessionToken } from "@/lib/session";

/** Role groups for API authorization. */
export const OWNER = ["OWNER"];
export const STAFF = ["OWNER", "PRODUCTION_MANAGER"];
export const ANYONE = ["OWNER", "PRODUCTION_MANAGER", "WORKER"];

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: string;
}

/** Resolve a server-managed session cookie, never trust a browser-supplied role. */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  try {
    const token = readSessionToken(req);
    if (!token) return null;
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, hashSessionToken(token)))
      .limit(1);
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await db.delete(sessions).where(eq(sessions.token, session.token));
      return null;
    }
    const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (!user || user.status !== "ACTIVE") return null;
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  } catch (error) {
    console.error("Session validation failed", error);
    return null;
  }
}

/** API guard: 401 without a session; 403 for the wrong role. */
export async function guard(req: Request, roles: string[]) {
  const user = await getSessionUser(req);
  if (!user)
    return NextResponse.json(
      { error: "Not signed in or your session expired. Please sign in again." },
      { status: 401 }
    );
  if (!roles.includes(user.role))
    return NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
  return null;
}

function normName(value: string) {
  return (value || "")
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|alaji|alhaji|dr)\b\.?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Worker accounts must match their Workers record by name. */
export async function getLinkedWorkerId(user: SessionUser): Promise<number | null> {
  const staff = await db.select().from(workers);
  return staff.find((person) => normName(person.name) === normName(user.name))?.id ?? null;
}
