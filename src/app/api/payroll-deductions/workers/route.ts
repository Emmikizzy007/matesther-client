import { NextResponse } from "next/server";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { workers } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { PayrollError, requiredOrganization } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";
import { chooseWorkers } from "@/lib/payroll-worker-selection";

/** Paginated Owner-only picker: no full worker/earnings/attendance table in the
 * browser. The bulk selector operates in SQL on the backend, not on this page. */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    if (p.get("view") === "eligible") {
      const rows = await chooseWorkers(org, {
        type: p.get("type"),
        workerIds: (p.get("workerIds") || "").split(",").filter(Boolean),
        department: p.get("department"), category: p.get("category"),
      });
      return NextResponse.json({ rows, count: rows.length }, { headers: PRIVATE_RESPONSE });
    }
    if (p.get("view") === "departments") {
      const rows = await db.select({ department: workers.department }).from(workers)
        .where(and(eq(workers.organizationId, org), eq(workers.status, "ACTIVE"),
          sql`${workers.department} is not null`)).groupBy(workers.department).orderBy(asc(workers.department)).limit(100);
      return NextResponse.json({ departments: rows.map((r) => r.department) }, { headers: PRIVATE_RESPONSE });
    }
    const search = (p.get("search") ?? "").trim();
    if (search.length > 100) throw new PayrollError("Search is too long.");
    const limit = p.has("limit") ? Number(p.get("limit")) : 25;
    const offset = p.has("offset") ? Number(p.get("offset")) : 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
      throw new PayrollError("Use limit 1–50 and a non-negative offset.");
    const condition = and(eq(workers.organizationId, org), eq(workers.status, "ACTIVE"), search
      ? or(ilike(workers.name, `%${search.replace(/[\\%_]/g, "\\$&")}%`), eq(workers.id, Number(search) || -1))
      : undefined);
    const [rows, count] = await Promise.all([
      db.select({ id: workers.id, name: workers.name, department: workers.department,
        paymentType: workers.paymentType, specialty: workers.specialty }).from(workers)
        .where(condition).orderBy(asc(workers.name), asc(workers.id)).limit(limit).offset(offset),
      db.select({ total: sql<number>`count(*)` }).from(workers).where(condition),
    ]);
    return NextResponse.json({ rows, total: Number(count[0]?.total ?? 0), limit, offset }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
