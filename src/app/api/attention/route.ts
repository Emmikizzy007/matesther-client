import { NextResponse } from "next/server";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { guard, STAFF } from "@/lib/authz";
import { db } from "@/db";
import { deliveries, materials, orders, productionBatches, supportAssignments } from "@/db/schema";
import { productionControl } from "@/lib/production-control";

export const dynamic = "force-dynamic";

/**
 * GET /api/attention
 *
 * Everything that needs a person's attention right now, in one read-only call: work awaiting
 * inspection, rework owed, overdue production, outsourced work not back, stages nobody is
 * assigned to, support work submitted and unjudged, finished garments not yet delivered,
 * material at or below its reorder level, and orders whose status was set to COMPLETED while
 * batches are still open.
 *
 * WHY THIS EXISTS AND WHAT IT DELIBERATELY IS NOT
 *
 * The repository has no notification system of any kind - no table, no queue, no push, no
 * email - and this does not add one. Every signal here is already derived somewhere the
 * business trusts: the production flags come from `productionControl`, the same derivation the
 * control board renders, so an alert can never disagree with the board it links to; finished
 * versus delivered comes from the ledger and the delivery records; shortage compares the two
 * columns the materials screen already shows. There is nothing new to keep in sync and nothing
 * a user can type.
 *
 * It is a PULL, not a push: a count and a link per kind of attention, fetched when a screen
 * asks. That is the smallest thing that answers "what needs me today" without introducing
 * infrastructure the ERP does not otherwise have.
 *
 * Staff-only. A Worker's own view of their work is the worker dashboard, which already scopes
 * to their allocations; management-wide alerts are not theirs to see, and this route does not
 * weaken that by being readable.
 */
export type AttentionAlert = {
  kind:
    | "OVERDUE_PRODUCTION"
    | "AWAITING_INSPECTION"
    | "REWORK_PENDING"
    | "OUTSOURCED_WAITING"
    | "UNASSIGNED"
    | "SUPPORT_AWAITING_APPROVAL"
    | "READY_FOR_DELIVERY"
    | "MATERIAL_SHORTAGE"
    | "COMPLETED_ORDER_WITH_OPEN_BATCHES";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  /** How much needs attention, in `unit` - batches, pieces, garments, materials or orders. */
  count: number;
  unit: string;
  /** The existing screen that deals with it. Nothing new to navigate to. */
  href: string;
};

export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    /**
     * One derivation, reused for five of the alerts below, so this endpoint and the control
     * board cannot report different numbers for the same factory floor.
     *
     * `openOnly: false`, deliberately. The board's default hides orders whose STATUS is
     * COMPLETED or CANCELLED - but a status is typed by a person, and the whole point of this
     * endpoint is that work needing attention stays visible whether or not somebody has
     * declared the order finished. An order marked complete by hand with six pieces sitting in
     * rework is exactly the case management must be told about; excluding it would let the
     * status column switch off the alarms about the work behind it. Genuinely finished batches
     * raise nothing anyway: a batch with no work left is flagged COMPLETE, which short-circuits
     * every other flag, so this widens the view without inventing noise.
     */
    const control = await productionControl({ openOnly: false, limit: 500 });
    const rows = control.rows;
    const withFlag = (flag: string) => rows.filter((row) => row.flags.includes(flag));

    const alerts: AttentionAlert[] = [];

    // ---- production, from the board's own flags ----
    const overdue = withFlag("OVERDUE");
    if (overdue.length)
      alerts.push({
        kind: "OVERDUE_PRODUCTION",
        severity: "high",
        title: "Production past its due date",
        detail: `${overdue.length} variant batch(es) on ${new Set(overdue.map((r) => r.orderId)).size} order(s) are past their due date, ${overdue.reduce((sum, r) => sum + r.remaining, 0)} garment(s) still to finish.`,
        count: overdue.length,
        unit: "batches",
        href: "/production/control?priority=1",
      });

    const awaiting = rows.filter((row) => row.awaitingInspectionTotal > 0);
    const awaitingPieces = awaiting.reduce((sum, row) => sum + row.awaitingInspectionTotal, 0);
    if (awaitingPieces > 0)
      alerts.push({
        kind: "AWAITING_INSPECTION",
        severity: "high",
        title: "Work submitted, awaiting inspection",
        detail: `${awaitingPieces} piece(s) across ${awaiting.length} batch(es) have been submitted and not yet judged. Nothing downstream can start until they are.`,
        count: awaitingPieces,
        unit: "pieces",
        href: "/production/inspection",
      });

    const reworkPieces = rows.reduce((sum, row) => sum + row.rework, 0);
    if (reworkPieces > 0)
      alerts.push({
        kind: "REWORK_PENDING",
        severity: "medium",
        title: "Rework outstanding",
        detail: `${reworkPieces} piece(s) were sent back for rework and have not been re-approved.`,
        count: reworkPieces,
        unit: "pieces",
        href: "/production/control?blocked=1",
      });

    const outsourced = withFlag("OUTSOURCED_WAITING");
    if (outsourced.length)
      alerts.push({
        kind: "OUTSOURCED_WAITING",
        severity: "medium",
        title: "Out with a vendor, not returned",
        detail: `${outsourced.length} outsourced stage(s) are waiting on a vendor. Only what comes back and is accepted becomes available downstream.`,
        count: outsourced.length,
        unit: "stages",
        href: "/production/external",
      });

    const unassigned = withFlag("UNASSIGNED");
    if (unassigned.length)
      alerts.push({
        kind: "UNASSIGNED",
        severity: "medium",
        title: "Stages with nobody assigned",
        detail: `${unassigned.length} batch(es) have work at their current stage with no live allocation to anybody.`,
        count: unassigned.length,
        unit: "batches",
        href: "/production/control",
      });

    // ---- support work submitted and unjudged ----
    const [supportRow] = await db
      .select({
        total: sql<number>`count(*)::int`,
        pieces: sql<number>`coalesce(sum(${supportAssignments.quantitySubmitted} - ${supportAssignments.quantityApproved} - ${supportAssignments.quantityRejected}), 0)::int`,
      })
      .from(supportAssignments)
      .where(eq(supportAssignments.status, "SUBMITTED"));
    const supportPieces = Number(supportRow?.pieces) || 0;
    if (Number(supportRow?.total) > 0)
      alerts.push({
        kind: "SUPPORT_AWAITING_APPROVAL",
        severity: "medium",
        title: "Support work awaiting approval",
        detail: `${supportRow?.total} support assignment(s) covering ${supportPieces} piece(s) have been submitted by a helper and not yet judged. A helper's pay, and the deduction from the tailor who handed the work out, both wait on this.`,
        count: Number(supportRow?.total) || 0,
        unit: "assignments",
        href: "/workers/assignments",
      });

    // ---- finished garments not yet delivered ----
    const approvedByOrder = new Map<number, number>();
    for (const row of rows) approvedByOrder.set(row.orderId, (approvedByOrder.get(row.orderId) ?? 0) + row.finished);
    const orderIds = [...approvedByOrder.keys()].filter((id) => (approvedByOrder.get(id) ?? 0) > 0);
    const deliveredRows = orderIds.length
      ? await db
          .select({ orderId: deliveries.orderId, total: sql<number>`coalesce(sum(${deliveries.deliveredQuantity}), 0)::int` })
          .from(deliveries)
          .where(inArray(deliveries.orderId, orderIds))
          .groupBy(deliveries.orderId)
      : [];
    const deliveredByOrder = new Map<number, number>(
      deliveredRows.map((row) => [row.orderId as number, Number(row.total) || 0])
    );
    let readyOrders = 0;
    let readyGarments = 0;
    for (const [orderId, approved] of approvedByOrder) {
      const gap = approved - (deliveredByOrder.get(orderId) ?? 0);
      if (gap > 0) {
        readyOrders += 1;
        readyGarments += gap;
      }
    }
    if (readyGarments > 0)
      alerts.push({
        kind: "READY_FOR_DELIVERY",
        severity: "low",
        title: "Approved and ready to deliver",
        detail: `${readyGarments} finished, approved garment(s) on ${readyOrders} order(s) have not been delivered yet.`,
        count: readyGarments,
        unit: "garments",
        href: "/deliveries",
      });

    // ---- material at or below its reorder level ----
    const short = await db
      .select({ id: materials.id, name: materials.name, currentStock: materials.currentStock, reorderLevel: materials.reorderLevel })
      .from(materials)
      .where(and(
        gt(materials.reorderLevel, 0),
        sql`coalesce(${materials.currentStock}, 0) <= ${materials.reorderLevel}`
      ))
      .limit(5);
    const [shortRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(materials)
      .where(and(
        gt(materials.reorderLevel, 0),
        sql`coalesce(${materials.currentStock}, 0) <= ${materials.reorderLevel}`
      ));
    const shortCount = Number(shortRow?.total) || 0;
    if (shortCount > 0)
      alerts.push({
        kind: "MATERIAL_SHORTAGE",
        severity: "medium",
        title: "Material at or below reorder level",
        detail: `${shortCount} item(s): ${short.map((m) => `${m.name} (${m.currentStock ?? 0} left, reorder at ${m.reorderLevel})`).join("; ")}.`,
        count: shortCount,
        unit: "materials",
        href: "/materials",
      });

    // ---- an order called complete while its batches are not ----
    const [mismatchRow] = await db
      .select({ total: sql<number>`count(distinct ${orders.id})::int` })
      .from(productionBatches)
      .innerJoin(orders, eq(orders.id, productionBatches.orderId))
      .where(and(
        eq(orders.status, "COMPLETED"),
        sql`${productionBatches.status} not in ('CANCELLED', 'COMPLETED')`
      ));
    const mismatch = Number(mismatchRow?.total) || 0;
    if (mismatch > 0)
      alerts.push({
        kind: "COMPLETED_ORDER_WITH_OPEN_BATCHES",
        severity: "high",
        title: "Orders marked complete with production still open",
        detail: `${mismatch} order(s) are marked COMPLETED but still have a batch that is neither finished nor cancelled. The status was changed by hand; the ledger does not agree with it.`,
        count: mismatch,
        unit: "orders",
        href: "/production/control",
      });

    const order: Record<AttentionAlert["severity"], number> = { high: 0, medium: 1, low: 2 };
    alerts.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        alerts,
        /** How many kinds of attention are outstanding - what a badge shows. */
        total: alerts.length,
        high: alerts.filter((a) => a.severity === "high").length,
        window: control.window,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e: any) {
    console.error("Attention load failed", e);
    return NextResponse.json(
      { error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
