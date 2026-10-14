import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, workerPayments, workers } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { monthLabel } from "@/lib/payroll";
import { buildBankSchedule } from "@/lib/bank-schedule";
import { getPayrollSummary, requiredOrganization } from "@/lib/payroll-deductions";

export const dynamic = "force-dynamic";

/**
 * GET /api/payment-sheet?month=YYYY-MM
 *
 * The Owner-only monthly staff payment sheet that gets sent to the bank: who is
 * being paid, how much is due, how much has already been paid, and the balance.
 *
 * Owner-only on purpose - this is the single most private document in the
 * system. Project Managers and Workers must never reach it, and the printable
 * page at /payment-sheet/[month] is useless without this endpoint.
 */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const requested = new URL(req.url).searchParams.get("month");
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested ?? "")
      ? (requested as string)
      : new Date().toISOString().slice(0, 7);

    const session = (await getSessionUser(req))!;
    const org = requiredOrganization(session);
    const { workers: rows, breakdown } = await getPayrollSummary(org, month);
    // A preview is for review, NOT a bank instruction. Unposted deductions
    // must be posted (or cancelled) before the payment sheet can be issued.
    if (rows.some((row) => row.mustPost && !row.finalized))
      return NextResponse.json({ error: "Approved deductions are still a preview. Post each affected completed worker-month before printing a bank payment sheet." }, { status: 409 });
    const [orgRows, payRows, accountRows] = await Promise.all([
      db
        .select({
          name: organizations.name,
          phone: organizations.phone,
          email: organizations.email,
          address: organizations.address,
        })
        .from(organizations)
        .where(eq(organizations.id, org))
        .limit(1),
      db.select({ payment: workerPayments }).from(workerPayments)
        .innerJoin(workers, eq(workers.id, workerPayments.workerId))
        .where(and(eq(workerPayments.periodMonth, month), eq(workers.organizationId, org))),
      // One batched read of the payout detail the bank schedule prints. The
      // account number is Owner-only data and this endpoint is Owner-only.
      db.select({ id: workers.id, bankAccountNumber: workers.bankAccountNumber }).from(workers)
        .where(eq(workers.organizationId, org)),
    ]);

    const accountByWorker = new Map(accountRows.map((row) => [row.id, row.bankAccountNumber]));
    // The most recent reference recorded for each person this month, so the bank
    // sheet can be matched against the transfers actually made.
    const referenceByWorker = new Map<number, string>();
    for (const { payment } of payRows) {
      if (payment.reference) referenceByWorker.set(payment.workerId, payment.reference);
    }

    // A bank sheet lists people to PAY, so a worker with nothing due is not on it.
    const payable = rows.filter((row) => row.due > 0 || row.paid > 0);

    /**
     * The sheet's totals describe the SHEET, not the whole payroll.
     *
     * A tailor who hands work out has their helper's rate deducted from their own,
     * and in a month where they approved no pieces themselves that deduction has
     * nothing to come out of yet. Those workers are not payees, so they are not
     * rows here - and a sheet whose total quietly included people it does not list
     * would not reconcile against the transfers actually made. What is left out is
     * reported as `notListed` instead, so the difference between this sheet and the
     * payroll screen is visible rather than mysterious.
     */
    const totals = payable.reduce(
      (t, row) => ({ due: t.due + row.due, paid: t.paid + row.paid, balance: t.balance + row.balance }),
      { due: 0, paid: 0, balance: 0 }
    );
    const omitted = rows.filter((row) => row.due <= 0 && row.paid <= 0);
    const notListed = {
      count: omitted.length,
      due: omitted.reduce((sum, row) => sum + row.due, 0),
      // Held back to be recovered from these workers' later piece-rate earnings.
      supportDeductionOwed: omitted.reduce((sum, row) => sum + row.supportDeductionOwed, 0),
    };

    return NextResponse.json(
      {
        sheetNo: `MTH-PAY-${month}`,
        month,
        monthLabel: monthLabel(month),
        generatedAt: new Date().toISOString(),
        business: orgRows[0] ?? null,
        rows: payable.map((row) => ({
          workerId: row.workerId,
          name: row.name,
          roles: row.roles,
          categories: row.categories,
          department: row.department,
          jobTitle: row.jobTitle,
          paymentType: row.paymentType,
          pieces: row.pieces,
          piecework: row.piecework,
          supportPieces: row.supportPieces,
          supportPiecework: row.supportPiecework,
          // Pieces handed out to a helper, and what that took back out of this
          // person's own rate. Itemised so the bank figure can be explained.
          supportPiecesDelegated: row.supportPiecesDelegated,
          supportDeduction: row.supportDeduction,
          supportDeductionArising: row.supportDeductionArising,
          supportDeductionOwed: row.supportDeductionOwed,
          salary: row.salary,
          overtime: row.overtime,
          other: row.other,
          gross: row.gross,
          deductionItems: row.deductionItems,
          totalDeductions: row.totalDeductions,
          taxDeduction: row.taxDeduction,
          finalized: row.finalized,
          due: row.due,
          paid: row.paid,
          balance: row.balance,
          paymentStatus: row.paymentStatus,
          bankAccountNumber: accountByWorker.get(row.workerId) ?? null,
          reference: referenceByWorker.get(row.workerId) ?? null,
        })),
        totals,
        breakdown,
        notListed,
        // The printable bank schedule: Staff Name / Bank Account Number /
        // Amount Payable only, non-payable people excluded, and a grand total
        // reconciled against the authoritative payroll + payment batches.
        bankSchedule: buildBankSchedule(
          payable.map((row) => ({
            workerId: row.workerId,
            name: row.name,
            due: row.due,
            paid: row.paid,
            balance: row.balance,
            paymentStatus: row.paymentStatus,
            bankAccountNumber: accountByWorker.get(row.workerId) ?? null,
          })),
          totals
        ),
        payableCount: payable.length,
        settledCount: payable.filter((row) => row.paymentStatus === "PAID").length,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error("Payment sheet load failed", error);
    return NextResponse.json({ error: "Unable to build the payment sheet." }, { status: 500 });
  }
}
