import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";

const COOKIE_NAME = "matesther_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export function readSessionToken(req: Request): string | null {
  const cookies = req.headers.get("cookie") ?? "";
  const value = cookies.match(/(?:^|;\s*)matesther_session=([^;]+)/)?.[1];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function attachNewSession(userId: number, response: NextResponse): Promise<NextResponse> {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({
    token: hashSessionToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
  });
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return response;
}

export async function revokeSession(req: Request, response: NextResponse): Promise<NextResponse> {
  const token = readSessionToken(req);
  if (token) {
    await db.delete(sessions).where(eq(sessions.token, hashSessionToken(token)));
  }
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function clearExpiredSessions() {
  await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
}
