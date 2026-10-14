import { NextResponse } from "next/server";
import { db } from "@/db";
import { workers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { PayrollError, requiredOrganization, safeId } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";
import { cooperativeHistory, cooperativeMembers } from "@/lib/cooperative";

/**
 * The cooperative savings fund, read-only.
 *
 * - ?workerId=N           one member's full transaction history (contributions,
 *                         paid withdrawals, approved adjustments) with the fund
 *                         balance after each transaction and the totals.
 * - ?view=members         the company-wide card data: total held, participating
 *                         workers, and a searchable per-worker list whose
 *                         balances sum exactly to the company total.
 *
 * The POSTED statement line IS the cooperative contribution transaction; there
 * is no second mutable balance or credit insert that can get out of sync.
 * Withdrawals reduce the fund only when PAID. Never book any of this as
 * company revenue or expense.
 */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    const limit = p.has("limit") ? Number(p.get("limit")) : 50;
    const offset = p.has("offset") ? Number(p.get("offset")) : 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
      throw new PayrollError("Use limit 1–100 and a non-negative offset.");
    if (p.get("view") === "members") {
      const search = (p.get("search") ?? "").trim();
      if (search.length > 100) throw new PayrollError("Search is too long.");
      const members = await cooperativeMembers(db, org, { search, limit, offset });
      return NextResponse.json(members, { headers: PRIVATE_RESPONSE });
    }
    const workerId = safeId(p.get("workerId"), "cooperative member");
    const [member] = await db.select({ id: workers.id }).from(workers).where(and(
      eq(workers.id, workerId), eq(workers.organizationId, org))).limit(1);
    if (!member) throw new PayrollError("Member not found in your organisation.", 404);
    const history = await cooperativeHistory(db, org, workerId, limit, offset);
    return NextResponse.json(history, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
