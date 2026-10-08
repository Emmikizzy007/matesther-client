import { NextResponse } from "next/server";
import { db } from "@/db";
import { users, workers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getLinkedWorkerId } from "@/lib/authz";
import { verifyPassword } from "@/lib/password";
import { attachNewSession, clearExpiredSessions } from "@/lib/session";
import { rejectCrossSiteMutation } from "@/lib/request-security";

// Per-instance throttling is a small first barrier; use an edge/WAF rate limit for internet-facing deployments.
const attempts = new Map<string, { count: number; first: number }>();
function rateLimited(key: string) {
  const now = Date.now();
  const attempt = attempts.get(key);
  if (!attempt || now - attempt.first > 15 * 60_000) {
    attempts.set(key, { count: 1, first: now });
    return false;
  }
  attempt.count += 1;
  return attempt.count > 8;
}

export async function POST(req: Request) {
  const crossSite = rejectCrossSiteMutation(req);
  if (crossSite) return crossSite;
  try {
    const body = await req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!email || !password)
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    if (rateLimited(email))
      return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !verifyPassword(password, user.passwordHash))
      return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
    if (user.status !== "ACTIVE")
      return NextResponse.json({ error: "Account inactive. Contact the owner." }, { status: 403 });

    // The signed-in person's own factory profile, resolved by the SAME function /api/auth/me
    // uses. Without it the client only learns who the login is linked to on a full page
    // reload, so a tailor who signs in and navigates straight to Support Work was shown no
    // hand-out action until they refreshed. Nothing is trusted from this on the way back in:
    // every action it enables is re-authorised by the server.
    const workerId = await getLinkedWorkerId({
      id: user.id, name: user.name, email: user.email, role: user.role,
      organizationId: user.organizationId, workerId: user.workerId,
    });
    const [profile] = workerId === null
      ? []
      : await db.select({ name: workers.name }).from(workers).where(eq(workers.id, workerId)).limit(1);
    const response = NextResponse.json({
      name: user.name, email: user.email, role: user.role,
      workerId, workerName: profile?.name ?? null,
    });
    await attachNewSession(user.id, response);
    clearExpiredSessions().catch(() => {});
    return response;
  } catch (error) {
    console.error("Sign-in failed", error);
    return NextResponse.json(
      { error: "Sign-in is temporarily unavailable. Check your database connection and deployment logs." },
      { status: 500 }
    );
  }
}
