import { NextResponse } from "next/server";
import { PayrollError } from "@/lib/payroll-deductions";

export function payrollFailure(error: unknown): NextResponse {
  if (error instanceof PayrollError) return NextResponse.json({ error: error.message }, { status: error.status });
  // PostgreSQL unique constraints are the final duplicate guard, including
  // simultaneous requests that both passed the ordinary validation checks.
  if (error && typeof error === "object") {
    const e = error as { code?: string; cause?: { code?: string } };
    if (e.code === "23505" || e.cause?.code === "23505")
      return NextResponse.json({ error: "This record has already been entered. Nothing was posted twice." }, { status: 409 });
  }
  console.error("Payroll deductions failed", error);
  return NextResponse.json({ error: "Unable to complete payroll deduction request." }, { status: 500 });
}

export const PRIVATE_RESPONSE = { "Cache-Control": "private, no-store" };
