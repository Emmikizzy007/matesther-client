import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { supportInspections } from "@/db/schema";
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
      const { supportAssignments } = await import("@/db/schema");
      const [assignment] = await db
        .select()
        .from(supportAssignments)
        .where(eq(supportAssignments.id, assignmentId))
        .limit(1);
      if (!assignment || (assignment.workerId !== myWorkerId && assignment.assignedByWorkerId !== myWorkerId))
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
