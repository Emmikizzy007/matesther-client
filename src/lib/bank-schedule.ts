/**
 * Derivation for the Monthly Staff Bank Payment Schedule.
 *
 * The schedule is a payment instruction, not a payroll report. It lists
 * exactly three fields per person - Staff Name, Bank Account Number, Amount
 * Payable - and everything else stays in the authorised payroll screens.
 *
 * Amount Payable is the FINAL NET for the month after every applicable
 * approved deduction (PAYE tax, cooperative, incident charges - each deducted
 * exactly once, never a preview or a proposed charge), less any payment
 * already recorded against this month so the bank cannot be told to pay the
 * same naira twice. With nothing paid yet - the normal case when a schedule
 * is issued - the figure is the full net. Non-payable people (nothing left to
 * transfer) are excluded and reported instead of silently dropped.
 *
 * The grand total is reconciled against the authoritative payroll totals and
 * the recorded payment batch. Any discrepancy is REPORTED on the document,
 * never hidden - the usual cause is an overpayment carried on a worker-month,
 * which is excluded from the transfer schedule and called out explicitly.
 */

export type SheetPayRow = {
  workerId: number;
  name: string;
  due: number;
  paid: number;
  balance: number;
  paymentStatus: string;
  bankAccountNumber: string | null;
};

export type AccountFlag = "OK" | "MISSING" | "CHECK";

export type BankScheduleEntry = {
  workerId: number;
  name: string;
  accountNumber: string | null;
  accountFlag: AccountFlag;
  amountPayable: number;
};

export type BankSchedule = {
  entries: BankScheduleEntry[];
  grandTotal: number;
  accountFlags: { missing: number; invalid: number };
  /** Staff already settled in full (or with nothing due) - not on the sheet. */
  settledExcluded: number;
  /** Balances that cannot be bank-transferred (overpayments) - excluded, reported. */
  nonPayableBalance: number;
  reconciliation: {
    /** Authoritative net payroll for the month, after all approved deductions. */
    netPayrollDue: number;
    /** The recorded payment batch for the month (money already moved). */
    paymentBatchPaid: number;
    /** Authoritative remaining for the month = netPayrollDue - paymentBatchPaid. */
    expectedRemaining: number;
    /** Grand total this schedule instructs the bank to transfer. */
    scheduleTotal: number;
    /** scheduleTotal - expectedRemaining. Anything other than 0 is printed. */
    discrepancy: number;
    reconciled: boolean;
  };
};

/** Standard Nigerian NUBAN is 10 digits. Anything else is printed as "check". */
const NUBAN = /^\d{10}$/;

export function accountFlag(accountNumber: string | null | undefined): AccountFlag {
  const value = (accountNumber ?? "").replace(/[\s-]/g, "");
  if (!value) return "MISSING";
  return NUBAN.test(value) ? "OK" : "CHECK";
}

export function buildBankSchedule(
  rows: readonly SheetPayRow[],
  totals: { due: number; paid: number; balance: number }
): BankSchedule {
  // Non-payable people are excluded: a settled worker must not appear as a
  // fresh transfer, and a worker with nothing (or less than nothing) left to
  // pay cannot be instructed to the bank.
  const payable = rows.filter((row) => row.balance > 0);
  const settledExcluded = rows.length - payable.length;
  const nonPayableBalance = rows
    .filter((row) => row.balance <= 0)
    .reduce((sum, row) => sum + row.balance, 0);
  const entries: BankScheduleEntry[] = payable.map((row) => ({
    workerId: row.workerId,
    name: row.name,
    accountNumber: row.bankAccountNumber ?? null,
    accountFlag: accountFlag(row.bankAccountNumber),
    amountPayable: row.balance,
  }));
  const grandTotal = entries.reduce((sum, entry) => sum + entry.amountPayable, 0);
  const accountFlags = {
    missing: entries.filter((entry) => entry.accountFlag === "MISSING").length,
    invalid: entries.filter((entry) => entry.accountFlag === "CHECK").length,
  };
  const netPayrollDue = totals.due;
  const paymentBatchPaid = totals.paid;
  const expectedRemaining = totals.balance;
  const discrepancy = grandTotal - expectedRemaining;
  return {
    entries,
    grandTotal,
    accountFlags,
    settledExcluded,
    nonPayableBalance,
    reconciliation: {
      netPayrollDue,
      paymentBatchPaid,
      expectedRemaining,
      scheduleTotal: grandTotal,
      discrepancy,
      reconciled: discrepancy === 0,
    },
  };
}
