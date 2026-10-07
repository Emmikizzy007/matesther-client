import { NextResponse } from "next/server";
import { db } from "@/db";
import { workers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionUser, getLinkedWorkerId } from "@/lib/authz";

/**
 * GET /api/auth/me - the signed-in person, used to restore a session on reload.
 *
 * WHY IT NOW CARRIES `workerId` AND `workerName`
 *   A tailor handing out support work, and a helper receiving it, are the same login
 *   role - WORKER - and the screens that serve them have to tell the two apart in
 *   order to offer the right actions. Until now they could not: the client knew the
 *   name, the email and the role, and nothing about which factory profile the login
 *   belonged to. The support screen therefore hid the "hand out" action from every
 *   Worker at all, which is what made delegation impossible from the factory floor
 *   even though the API had always permitted it.
 *
 *   Both values are THE CALLER'S OWN, resolved by `getLinkedWorkerId` - the same
 *   server-side function every worker-scoped endpoint already uses, which returns
 *   null for a Worker who has no unambiguous profile of their own. Nothing about
 *   anybody else is exposed, and no client-side decision made from these fields is
 *   trusted: every action they enable is re-authorised server-side, so forging them
 *   in a browser buys nothing.
 *
 *   The name is included so a screen can say "your share" without a second request
 *   for a record the caller is entitled to anyway.
 */
export async function GET(req: Request) {
  const u = await getSessionUser(req);
  if (!u) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const workerId = await getLinkedWorkerId(u);
  let workerName: string | null = null;
  if (workerId !== null) {
    const [profile] = await db
      .select({ name: workers.name })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    workerName = profile?.name ?? null;
  }
  return NextResponse.json({
    name: u.name,
    email: u.email,
    role: u.role,
    workerId,
    workerName,
  });
}
