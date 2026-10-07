import { NextResponse } from "next/server";
import { guard, STAFF } from "@/lib/authz";
import { productionControl, rollUpByOrder, PRIORITY_LABELS, type ControlFilters } from "@/lib/production-control";
import { STAGES } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * GET /api/production-control - the route-aware production control board.
 *
 *   ?search=          order number or school name
 *   ?orderId=&batchId=
 *   ?dueWithinDays=   due today or within N days; work already late is always included
 *   ?stage=           only batches whose CURRENT route stage is this one
 *   ?priority=        1 OVERDUE, 2 DUE SOON, 3 BLOCKED, 4 SCHEDULED, 5 NORMAL, 6 COMPLETE
 *   ?blockedOnly=1    only batches where work exists but nothing is moving
 *   ?supportPausedOnly=1  only batches whose support work has stopped
 *   ?all=1            include COMPLETED and CANCELLED orders too
 *   ?limit=&offset=   paging
 *
 * EVERY FIGURE IS DERIVED AND NONE IS EDITABLE. There is no POST and no PUT here on
 * purpose: this endpoint reports what the ledger, the frozen route, the allocations and
 * the inspections already say. Quantities are changed where they have always been
 * changed - by submitting work, inspecting it, or recording an audited correction - so
 * nothing on this board can ever disagree with the record behind it.
 *
 * Staff only. A Worker sees their own exact work through their own dashboard, never the
 * whole board, and no price or profit figure appears here at all.
 */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const query = new URL(req.url).searchParams;
    const number = (key: string): number | null => {
      const raw = query.get(key);
      if (raw === null || raw === "") return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) ? value : null;
    };

    const filters: ControlFilters = {
      orderId: number("orderId"),
      batchId: number("batchId"),
      search: query.get("search"),
      openOnly: query.get("all") !== "1",
      dueWithinDays: number("dueWithinDays"),
      stage: query.get("stage"),
      priority: number("priority"),
      blockedOnly: query.get("blockedOnly") === "1",
      supportPausedOnly: query.get("supportPausedOnly") === "1",
      limit: number("limit") ?? undefined,
      offset: number("offset") ?? undefined,
    };

    const result = await productionControl(filters);
    return NextResponse.json(
      {
        rows: result.rows,
        // The same rows rolled up per school/order, so the board can be read at either
        // grain without a second request or a second source of truth.
        orders: rollUpByOrder(result.rows),
        total: result.total,
        window: result.window,
        appliedAfterDerivation: result.appliedAfterDerivation,
        priorities: PRIORITY_LABELS,
        stages: STAGES,
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Total-Count": String(result.total),
        },
      }
    );
  } catch (error) {
    console.error("Production control load failed", error);
    return NextResponse.json({ error: "Unable to load production control." }, { status: 500 });
  }
}
