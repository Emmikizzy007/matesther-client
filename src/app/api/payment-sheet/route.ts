import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, workerPayments } from "@/db/schema";
import { guard, OWNER } from "@/lib/authz";
import { workerAccruals, monthLabel } from "@/lib/payroll";

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

    const { workers: rows, breakdown } = await workerAccruals(month);
    const [orgRows, payRows] = await Promise.all([
      db
        .select({
          name: organizations.name,
          phone: organizations.phone,
          email: organizations.email,
          address: organizations.address,
        })
        .from(organizations)
        .where(eq(organizations.id, 1))
        .limit(1),
      db.select().from(workerPayments).where(eq(workerPayments.periodMonth, month)),
    ]);

    // The most recent reference recorded for each person this month, so the bank
    // sheet can be matched against the transfers actually made.
    const referenceByWorker = new Map<number, string>();
    for (const payment of payRows) {
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
          due: row.due,
          paid: row.paid,
          balance: row.balance,
          paymentStatus: row.paymentStatus,
          reference: referenceByWorker.get(row.workerId) ?? null,
        })),
        totals,
        breakdown,
        notListed,
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
