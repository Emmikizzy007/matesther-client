import { NextResponse } from "next/server";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import {
  executeTestOrderPurge,
  previewTestOrderPurge,
  purgeHistory,
} from "@/lib/test-data-cleanup";

export const dynamic = "force-dynamic";

/**
 * ADMINISTRATIVE TEST-DATA CLEANUP.
 *
 *   GET  /api/test-data-cleanup?orderId=7            preview: what would be removed
 *   GET  /api/test-data-cleanup?history=1            the permanent record of past purges
 *   POST /api/test-data-cleanup                      execute, with typed confirmations
 *
 * OWNER ONLY. There is no role for which clearing test business data is a normal task,
 * and no `STAFF` fallback here: a Project Manager manages production, not the database.
 * The guard runs before anything is read, so a non-Owner cannot even see a preview -
 * knowing exactly which records exist behind an order is itself information about the
 * business.
 *
 * WHY THIS ENDPOINT EXISTS ALONGSIDE THE ORDERS SCREEN
 *   An order with approved production and settled money cannot be deleted from the Orders
 *   screen, and that protection stays exactly as it is. Clearing test records before the
 *   business goes live genuinely requires removing such an order, so the act is given its
 *   own door: a preview, two typed confirmations, a reason, a fingerprint that expires the
 *   moment anything changes, and a permanent audit row. It is a narrower and louder path
 *   than deletion, not a quieter one.
 *
 * WHAT IT CANNOT DO
 *   It removes ONE order and the records belonging to that order. There is no bulk form,
 *   no "all orders for this school", no date range and no filter. Shared master data -
 *   the school, the garments, the workers, the routes, the materials, the organisation -
 *   is never a candidate, so it cannot be named here. Settled payroll is reported and
 *   never rewritten, because a payment that has already gone to a bank is a fact about the
 *   world rather than a row to tidy.
 */

/** GET - preview, or the audit history. Reads nothing until the guard has passed. */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const query = new URL(req.url).searchParams;

    if (query.get("history") === "1") {
      const history = await purgeHistory(session.organizationId, 50);
      return NextResponse.json(history, { headers: { "Cache-Control": "private, no-store" } });
    }

    const rawOrderId = query.get("orderId");
    if (!rawOrderId || !/^\d+$/.test(rawOrderId.trim()))
      return NextResponse.json({ error: "Choose the order to clean up." }, { status: 400 });
    const orderId = Number(rawOrderId.trim());

    const preview = await previewTestOrderPurge(session.organizationId, orderId);
    if ("error" in preview) return NextResponse.json(preview, { status: 404 });
    return NextResponse.json(preview, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Test-data cleanup preview failed", error);
    return NextResponse.json({ error: "Could not prepare the cleanup preview." }, { status: 500 });
  }
}

/**
 * POST - execute.
 * { orderId, confirmCustomerName, confirmOrderNumber, reason, fingerprint }
 *
 * The actor is taken from the session. It is never accepted from the body, for the same
 * reason `payments.recorded_by_*` and payroll's `paid_by` are derived server-side: on a
 * record whose whole purpose is to say who destroyed something, a caller-supplied name
 * would make the audit worthless.
 */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const body = await req.json();

    const rawOrderId = Number(body.orderId);
    if (!Number.isSafeInteger(rawOrderId) || rawOrderId < 1)
      return NextResponse.json({ error: "Choose the order to clean up." }, { status: 400 });

    const result = await executeTestOrderPurge({
      organizationId: session.organizationId,
      orderId: rawOrderId,
      confirmCustomerName: String(body.confirmCustomerName ?? ""),
      confirmOrderNumber: String(body.confirmOrderNumber ?? ""),
      reason: String(body.reason ?? ""),
      fingerprint: String(body.fingerprint ?? ""),
      actor: { userId: session.id, name: session.name },
    });

    if (!("ok" in result)) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Test-data cleanup failed", error);
    return NextResponse.json(
      { error: "The cleanup did not complete. Nothing was removed - it runs as one transaction, so it either removes everything it described or nothing at all." },
      { status: 500 }
    );
  }
}
