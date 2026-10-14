"use client";

import { use, useCallback, useEffect, useState } from "react";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { Letterhead, type LetterBusiness } from "@/components/documents/Letterhead";
import { PaginatedTable } from "@/components/documents/PaginatedTable";
import { SkeletonDocument, LoadError } from "@/components/Skeleton";
import { buildBankSchedule, type BankSchedule, type SheetPayRow } from "@/lib/bank-schedule";
import { fmtDate, naira } from "@/lib/format";

type SheetRow = SheetPayRow & {
  roles: string[];
  reference: string | null;
};

type PaymentSheet = {
  sheetNo: string;
  month: string;
  monthLabel: string;
  generatedAt: string;
  business: LetterBusiness | null;
  rows: SheetRow[];
  totals: { due: number; paid: number; balance: number };
  bankSchedule: BankSchedule;
  payableCount: number;
  notListed: { count: number; due: number; supportDeductionOwed: number };
};

/**
 * Monthly Staff Bank Payment Schedule.
 *
 * The bank table carries exactly three columns - Staff Name, Bank Account
 * Number and Amount Payable (the final net after every approved deduction,
 * less payments already recorded). The internal payroll breakdown stays in
 * the authorised Worker Payments and Payroll Deductions screens; it is not
 * printed here and not included in the shareable message.
 */
export default function PaymentSheetPage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = use(params);
  const [sheet, setSheet] = useState<PaymentSheet | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    fetch(`/api/payment-sheet?month=${encodeURIComponent(month)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load the payment schedule.");
        return result as PaymentSheet;
      })
      .then((result) => { if (active) setSheet(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load the payment schedule."); });
    return () => { active = false; };
  }, [month, reload]);

  const retry = useCallback(() => setReload((n) => n + 1), []);

  if (error)
    return (
      <div className="document-page min-h-screen bg-[#f2f3ee] p-4 sm:p-8">
        <div className="mx-auto max-w-[210mm]">
          <LoadError message={`${error} Sign in as the Owner to open a payment schedule.`} onRetry={retry}>
            <p className="mt-2 text-xs font-normal text-red-700">
              <a href="/login" className="font-semibold underline">Sign in</a> if your session has expired.
            </p>
          </LoadError>
        </div>
      </div>
    );
  if (!sheet)
    return (
      <main className="document-page min-h-screen bg-[#f2f3ee] px-3 py-6 sm:px-6">
        <SkeletonDocument label="Loading the Matesther bank payment schedule…" rows={10} />
      </main>
    );

  const schedule = sheet.bankSchedule ?? buildBankSchedule(sheet.rows, sheet.totals);
  const { reconciliation } = schedule;
  const preparedDate = fmtDate(sheet.generatedAt);

  const note = [
    `${sheet.business?.name || "Matesther Enterprises"} Monthly Staff Bank Payment Schedule ${sheet.sheetNo}`,
    `Payroll month: ${sheet.monthLabel}`,
    `Prepared: ${preparedDate}`,
    `Staff on schedule: ${schedule.entries.length}`,
    `Grand total payable: ${naira(schedule.grandTotal)}`,
    `For the letterheaded schedule with account numbers and signatures, use Print / Save as PDF and attach the saved file. Confidential payroll document - check the recipient before sharing.`,
  ].join("\n");

  return (
    <main className="document-page min-h-screen bg-[#f2f3ee] px-3 py-6 sm:px-6">
      <DocumentActions
        title={`Matesther Monthly Staff Bank Payment Schedule ${sheet.sheetNo}`}
        filename={`matesther-bank-payment-schedule-${sheet.month}`}
        message={note}
        sensitive
      />
      <Letterhead
        business={sheet.business}
        ourRef={sheet.sheetNo}
        yourRef={`Payroll ${sheet.month}`}
        date={preparedDate}
        title="Monthly Staff Bank Payment Schedule"
        subtitle={`Payroll month: ${sheet.monthLabel}`}
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Payroll month</p>
            <p className="mt-1 font-semibold text-[#282b25]">{sheet.monthLabel}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Prepared on</p>
            <p className="mt-1 font-semibold text-[#282b25]">{preparedDate}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Staff on this schedule</p>
            <p className="mt-1 font-semibold text-[#282b25]">{schedule.entries.length}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Grand total payable</p>
            <p className="mt-1 font-semibold text-[#282b25]">{naira(schedule.grandTotal)}</p>
          </div>
        </div>

        {schedule.entries.length === 0 ? (
          <p className="mt-6 rounded border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            No staff payments are payable for {sheet.monthLabel}.
          </p>
        ) : (
          <>
            {/* Mobile: one readable card per person - no whole-page scrolling. */}
            <div className="mt-6 space-y-3 sm:hidden">
              {schedule.entries.map((entry, index) => (
                <div key={entry.workerId} className="rounded-lg border border-[#d8d3c4] bg-[#faf9f5] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase tracking-wide text-[#6b6250]">#{index + 1} Staff name</p>
                      <p className="break-words font-semibold text-[#282b25]">{entry.name}</p>
                    </div>
                    <p className="shrink-0 text-right">
                      <span className="block text-[10px] uppercase tracking-wide text-[#6b6250]">Amount payable</span>
                      <span className="font-bold tabular-nums text-[#282b25]">{naira(entry.amountPayable)}</span>
                    </p>
                  </div>
                  <p className="mt-2 text-[10px] uppercase tracking-wide text-[#6b6250]">Bank account number</p>
                  <p className={entry.accountFlag === "OK" ? "tabular-nums font-semibold text-[#282b25]" : "font-semibold text-[#a4573c]"}>
                    {entry.accountNumber ?? "Not on file"}
                    {entry.accountFlag === "CHECK" && " — check number"}
                    {entry.accountFlag === "MISSING" && " — add before transfer"}
                  </p>
                </div>
              ))}
              <div className="rounded-lg border-t-2 border-[#987048] bg-[#f6f4ee] p-3">
                <p className="flex items-center justify-between font-bold text-[#282b25]">
                  <span>Grand total payable</span>
                  <span className="tabular-nums">{naira(schedule.grandTotal)}</span>
                </p>
              </div>
            </div>

            {/* Screen (sm+) and print: the paginated bank table. */}
            <div className="mt-6 hidden sm:block">
              <PaginatedTable
                rows={schedule.entries}
                rowKey={(entry) => entry.workerId}
                rowsFirstPage={22}
                rowsPerPage={32}
                continuationLabel={`Bank payment schedule ${sheet.sheetNo}`}
                footerLeft={`${sheet.sheetNo} · ${sheet.monthLabel} · Prepared ${preparedDate}`}
                columns={[
                  { header: "S/N", widthClass: "w-12" },
                  { header: "Staff Name" },
                  { header: "Bank Account Number" },
                  { header: "Amount Payable", align: "right", widthClass: "w-36" },
                ]}
                renderRow={(entry, index) => (
                  <>
                    <td>{index + 1}</td>
                    <td className="font-semibold text-[#282b25]">{entry.name}</td>
                    <td className={entry.accountFlag === "OK" ? "tabular-nums" : "font-semibold text-[#a4573c]"}>
                      {entry.accountNumber ?? "Not on file"}
                      {entry.accountFlag === "CHECK" && " — check number"}
                      {entry.accountFlag === "MISSING" && " — add before transfer"}
                    </td>
                    <td className="font-bold tabular-nums text-[#282b25]">{naira(entry.amountPayable)}</td>
                  </>
                )}
                renderTotalRow={
                  <tr className="border-t-2 border-[#987048] bg-[#f6f4ee] font-bold text-[#282b25]">
                    <td colSpan={3}>Grand total payable — {sheet.monthLabel}</td>
                    <td className="tabular-nums">{naira(schedule.grandTotal)}</td>
                  </tr>
                }
              />
            </div>
          </>
        )}

        {(schedule.accountFlags.missing > 0 || schedule.accountFlags.invalid > 0) && (
          <p className="mt-4 border-l-2 border-[#c9642f] pl-3 text-[11px] leading-relaxed text-[#6b4a35]">
            {schedule.accountFlags.missing > 0 &&
              `${schedule.accountFlags.missing} staff ${schedule.accountFlags.missing === 1 ? "account number is" : "account numbers are"} not on file and ${schedule.accountFlags.missing === 1 ? "has" : "have"} been flagged above. `}
            {schedule.accountFlags.invalid > 0 &&
              `${schedule.accountFlags.invalid} account ${schedule.accountFlags.invalid === 1 ? "number does" : "numbers do"} not look like a standard 10-digit NUBAN - confirm with the staff member before transfer. `}
            No account number has been invented: record the real one on the Workers screen and reprint.
          </p>
        )}

        {/* Reconciliation against the authoritative payroll and payment batches. */}
        <div className="letter-total-box mt-6">
          <p className="font-serif text-[15px] font-semibold text-[#30312e]">Reconciliation</p>
          <dl className="mt-2 space-y-1 text-xs text-[#4a4f45]">
            <div className="flex justify-between gap-4">
              <dt>Net payroll for {sheet.monthLabel} (after all approved deductions)</dt>
              <dd className="font-semibold tabular-nums">{naira(reconciliation.netPayrollDue)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Less payments already recorded for the month (payment batch)</dt>
              <dd className="font-semibold tabular-nums">−{naira(reconciliation.paymentBatchPaid)}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-[#cad2b0] pt-1">
              <dt>Expected remaining payable</dt>
              <dd className="font-semibold tabular-nums">{naira(reconciliation.expectedRemaining)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Grand total on this schedule</dt>
              <dd className="font-bold tabular-nums">{naira(reconciliation.scheduleTotal)}</dd>
            </div>
          </dl>
          <p className={`mt-2 text-xs font-semibold ${reconciliation.reconciled ? "text-[#166b3d]" : "text-[#a4573c]"}`}>
            {reconciliation.reconciled
              ? "Reconciled: this schedule matches the authoritative payroll and payment records for the month."
              : `DISCREPANCY of ${naira(Math.abs(reconciliation.discrepancy))} vs the authoritative records - investigate before transferring.`}
          </p>
          {!reconciliation.reconciled && schedule.nonPayableBalance !== 0 && (
            <p className="mt-1 text-[11px] text-[#6b6250]">
              Explained in part by {naira(Math.abs(schedule.nonPayableBalance))} in overpaid or non-payable balances
              ({schedule.settledExcluded} settled staff excluded from this schedule) - the payroll records show the detail.
            </p>
          )}
        </div>

        {sheet.notListed.count > 0 && (
          <p className="mt-3 border-l-2 border-[#c9c3b2] pl-3 text-[11px] leading-relaxed text-[#6b6250]">
            {sheet.notListed.count} worker{sheet.notListed.count === 1 ? "" : "s"} not listed on this
            schedule{sheet.notListed.supportDeductionOwed > 0
              ? `: a support deduction of ${naira(sheet.notListed.supportDeductionOwed)} arose against work they did not themselves approve this month, so there is no piece-rate earning to deduct it from yet`
              : ""}.
            It is carried forward against their later piece-rate earnings, never written off, and
            is why this schedule&apos;s total differs from the payroll screen.
          </p>
        )}

        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="border-b border-[#c9c3b2] pb-6 text-[11px] uppercase tracking-wide text-[#6b6250]">
              Prepared by (name, signature, date)
            </p>
          </div>
          <div>
            <p className="border-b border-[#c9c3b2] pb-6 text-[11px] uppercase tracking-wide text-[#6b6250]">
              Approved by (name, signature, date)
            </p>
          </div>
        </div>

        <p className="mt-6 text-[10px] leading-relaxed text-[#6b6250]">
          Amount Payable is the final net for the month after every applicable approved deduction (PAYE tax, cooperative
          and incident charges are each deducted exactly once), less any payment already recorded for the month. Piecework
          and support-work amounts are calculated from inspected and approved pieces only. This schedule is confidential
          Matesther payroll information and is intended for the Owner and Matesther&apos;s bank.
        </p>
      </Letterhead>
    </main>
  );
}
