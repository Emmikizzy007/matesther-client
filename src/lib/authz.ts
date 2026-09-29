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
  organizationId: number | null;
  workerId: number | null;
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
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      workerId: user.workerId,
    };
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

function comparableName(value: string): string {
  return value.toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|alhaji|dr)\.?\s+/g, "")
    .replace(/\s+/g, " ").trim();
}

/**
 * Existing saved links are honoured. For Worker logins made before a factory
 * record exists, find one exact, unambiguous name match in the same company.
 * Never match a substring or return another worker's production history.
 */
export async function getLinkedWorkerId(user: SessionUser): Promise<number | null> {
  if (!(["WORKER", "PRODUCTION_MANAGER"] as string[]).includes(user.role) || !user.organizationId) return null;
  // Supervisors opt in to the factory role through Users. Regular Workers can
  // still be added before their Workers record and matched unambiguously later.
  if (user.role === "PRODUCTION_MANAGER" && !user.workerId) return null;
  if (user.workerId) {
    const [linked] = await db.select({ id: workers.id, organizationId: workers.organizationId, status: workers.status })
      .from(workers).where(eq(workers.id, user.workerId)).limit(1);
    return linked?.organizationId === user.organizationId && linked.status === "ACTIVE" ? linked.id : null;
  }
  const [profiles, accounts] = await Promise.all([
    db.select({ id: workers.id, name: workers.name, status: workers.status }).from(workers)
      .where(eq(workers.organizationId, user.organizationId)),
    db.select({ id: users.id, name: users.name, role: users.role, workerId: users.workerId }).from(users)
      .where(eq(users.organizationId, user.organizationId)),
  ]);
  const name = comparableName(user.name);
  const candidates = profiles.filter((person) => person.status === "ACTIVE" && comparableName(person.name) === name);
  if (candidates.length !== 1) return null;
  const competing = accounts.some((account) => account.id !== user.id && ["WORKER", "PRODUCTION_MANAGER"].includes(account.role) &&
    (account.workerId === candidates[0].id || comparableName(account.name) === name));
  return competing ? null : candidates[0].id;
}
