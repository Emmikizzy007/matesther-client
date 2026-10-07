import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { supportAssignments, supportInspections } from "@/db/schema";
import { guard, ANYONE, getLinkedWorkerId, getSessionUser } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * GET /api/support-work/inspections?assignmentId=N
 *
 * The append-only inspection history for one support assignment. Every pass is a
 * separate row, so rework and rejection are preserved rather than overwritten.
 */
export async function GET(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const assignmentId = Number(new URL(req.url).searchParams.get("assignmentId"));
    if (!Number.isSafeInteger(assignmentId) || assignmentId < 1)
      return NextResponse.json({ error: "Choose a support assignment." }, { status: 400 });
    // A Worker may only read the trail for support work they are part of.
    const myWorkerId = session.role === "WORKER" ? await getLinkedWorkerId(session) : null;
    if (myWorkerId) {
      const [assignment] = await db
        .select()
        .from(supportAssignments)
        .where(eq(supportAssignments.id, assignmentId))
        .limit(1);
      if (!assignment || (assignment.workerId !== myWorkerId && assignment.assignedByWorkerId !== myWorkerId))
        return NextResponse.json({ error: "Support assignment not found." }, { status: 404 });
    } else {
      /*
       * A supervisor is scoped by ORGANISATION rather than by participation.
       *
       * The Worker branch above already answers "is this mine?", but a supervisor has no
       * worker record to compare, so without this branch any OWNER or PRODUCTION_MANAGER
       * could read any organisation's inspection history by walking assignment ids. That
       * discloses another company's piece rates and rework, which is exactly what the
       * Project Manager finance blackout exists to prevent inside one organisation.
       *
       * 404, not 403, so an id cannot be probed for existence. A legacy assignment with
       * no organisation is not refused, matching PUT on the parent route.
       */
      const [assignment] = await db
        .select({ organizationId: supportAssignments.organizationId })
        .from(supportAssignments)
        .where(eq(supportAssignments.id, assignmentId))
        .limit(1);
      if (!assignment)
        return NextResponse.json({ error: "Support assignment not found." }, { status: 404 });
      if (assignment.organizationId !== null && session.organizationId !== null
        && assignment.organizationId !== session.organizationId)
        return NextResponse.json({ error: "Support assignment not found." }, { status: 404 });
    }
    const rows = await db
      .select()
      .from(supportInspections)
      .where(eq(supportInspections.supportAssignmentId, assignmentId));
    return NextResponse.json(rows, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Support inspection history load failed", error);
    return NextResponse.json({ error: "Unable to load the inspection history." }, { status: 500 });
  }
}
