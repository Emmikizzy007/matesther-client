import { NextResponse } from "next/server";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { assertMonth, postPayroll, safeId } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";

/** Owner reviews /api/payroll first. Posting freezes one completed worker-month
 * and atomically books one line per approved proposal + cooperative credit. */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const body = await req.json();
    const result = await postPayroll(actor, safeId(body.workerId, "worker"), assertMonth(body.month));
    return NextResponse.json(result, { status: 201, headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
