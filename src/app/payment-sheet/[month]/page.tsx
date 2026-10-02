"use client";

import { use, useEffect, useState } from "react";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { Letterhead, type LetterBusiness } from "@/components/documents/Letterhead";
import { fmtDate, naira } from "@/lib/format";

type SheetRow = {
  workerId: number;
  name: string;
  roles: string[];
  categories: string[];
  department: string | null;
  jobTitle: string | null;
  paymentType: string;
  pieces: number;
  piecework: number;
  supportPieces: number;
  supportPiecework: number;
  salary: number;
  overtime: number;
  other: number;
  due: number;
  paid: number;
  balance: number;
  paymentStatus: string;
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
  breakdown: { piecework: number; supportPiecework: number; salary: number; overtime: number; other: number };
  payableCount: number;
  settledCount: number;
};

const STATUS_LABEL: Record<string, string> = {
  PAID: "Paid in full",
  PARTIAL: "Part paid",
  UNPAID: "Not yet paid",
  NOTHING_DUE: "Nothing due",
};

export default function PaymentSheetPage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = use(params);
  const [sheet, setSheet] = useState<PaymentSheet | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`/api/payment-sheet?month=${encodeURIComponent(month)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load the payment sheet.");
        return result as PaymentSheet;
      })
      .then((result) => { if (active) setSheet(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load the payment sheet."); });
    return () => { active = false; };
  }, [month]);

  if (error)
    return (
      <div className="document-page min-h-screen bg-[#f2f3ee] p-8 text-center text-sm text-red-700" role="alert">
        {error} <a href="/login" className="underline">Sign in</a> as the Owner to open a payment sheet.
      </div>
    );
  if (!sheet)
    return <div className="document-page min-h-screen bg-[#f2f3ee] p-8 text-center text-sm text-slate-500">Loading the Matesther payment sheet...</div>;

  const note = [
    `${sheet.business?.name || "Matesther Enterprises"} monthly staff payment sheet ${sheet.sheetNo}`,
    `Month: ${sheet.monthLabel}`,
    ...sheet.rows.map(
      (row) =>
        `${row.name} (${row.roles.join(", ") || row.paymentType}) - due ${naira(row.due)}, paid ${naira(row.paid)}, balance ${naira(row.balance)}`
    ),
    `Total payable: ${naira(sheet.totals.due)}`,
    `Already paid: ${naira(sheet.totals.paid)}`,
    `Outstanding: ${naira(sheet.totals.balance)}`,
    `Print or Save as PDF for the full letterheaded sheet.`,
  ].join("\n");

  return (
    <main className="document-page min-h-screen bg-[#f2f3ee] px-3 py-6 sm:px-6">
      <DocumentActions
        title={`Matesther staff payment sheet ${sheet.sheetNo}`}
        filename={`matesther-payment-sheet-${sheet.month}`}
        message={note}
      />
      <Letterhead
        business={sheet.business}
        ourRef={sheet.sheetNo}
        yourRef={`Payroll ${sheet.month}`}
        date={fmtDate(sheet.generatedAt)}
        title="Monthly Staff Payment Sheet"
        subtitle={`Payments due for ${sheet.monthLabel}`}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Period</p>
            <p className="mt-1 font-semibold text-[#282b25]">{sheet.monthLabel}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Staff on this sheet</p>
            <p className="mt-1 font-semibold text-[#282b25]">{sheet.payableCount}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Settled</p>
            <p className="mt-1 font-semibold text-[#282b25]">
              {sheet.settledCount} of {sheet.payableCount}
            </p>
          </div>
        </div>

        {sheet.rows.length === 0 ? (
          <p className="mt-6 rounded border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            No staff payments are due for {sheet.monthLabel}.
          </p>
        ) : (
          <table className="mt-6 w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-y border-[#d8d3c4] bg-[#f6f4ee] text-left uppercase tracking-wide text-[#6b6250]">
                <th className="px-2 py-2">Staff</th>
                <th className="px-2 py-2">Role / Position</th>
                <th className="px-2 py-2">Pay type</th>
                <th className="px-2 py-2 text-right">Salary</th>
                <th className="px-2 py-2 text-right">Piecework</th>
                <th className="px-2 py-2 text-right">Support</th>
                <th className="px-2 py-2 text-right">Overtime</th>
                <th className="px-2 py-2 text-right">Other</th>
                <th className="px-2 py-2 text-right">Total due</th>
                <th className="px-2 py-2 text-right">Paid</th>
                <th className="px-2 py-2 text-right">Balance</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.workerId} className="border-b border-[#e6e2d6] align-top">
                  <td className="px-2 py-2 font-semibold text-[#282b25]">
                    {row.name}
                    {(row.department || row.jobTitle) && (
                      <span className="block font-normal text-[#6b6250]">
                        {[row.jobTitle, row.department].filter(Boolean).join(" - ")}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-[#4a4f45]">{row.roles.join(", ") || "-"}</td>
                  <td className="px-2 py-2 text-[#4a4f45]">{row.paymentType.replace("_", " ")}</td>
                  <td className="px-2 py-2 text-right">{row.salary ? naira(row.salary) : "-"}</td>
                  <td className="px-2 py-2 text-right">
                    {row.piecework ? `${naira(row.piecework)}` : "-"}
                    {row.piecework > 0 && <span className="block text-[#6b6250]">{row.pieces} pcs</span>}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {row.supportPiecework ? `${naira(row.supportPiecework)}` : "-"}
                    {row.supportPiecework > 0 && <span className="block text-[#6b6250]">{row.supportPieces} pcs</span>}
                  </td>
                  <td className="px-2 py-2 text-right">{row.overtime ? naira(row.overtime) : "-"}</td>
                  <td className="px-2 py-2 text-right">{row.other ? naira(row.other) : "-"}</td>
                  <td className="px-2 py-2 text-right font-bold text-[#282b25]">{naira(row.due)}</td>
                  <td className="px-2 py-2 text-right">{row.paid ? naira(row.paid) : "-"}</td>
                  <td className="px-2 py-2 text-right font-semibold">{row.balance > 0 ? naira(row.balance) : "-"}</td>
                  <td className="px-2 py-2 text-[#4a4f45]">
                    {STATUS_LABEL[row.paymentStatus] ?? row.paymentStatus}
                    {row.reference && <span className="block text-[#6b6250]">Ref {row.reference}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[#987048] bg-[#f6f4ee] font-bold text-[#282b25]">
                <td className="px-2 py-2" colSpan={3}>
                  Total - {sheet.monthLabel}
                </td>
                <td className="px-2 py-2 text-right">{naira(sheet.breakdown.salary)}</td>
                <td className="px-2 py-2 text-right">{naira(sheet.breakdown.piecework)}</td>
                <td className="px-2 py-2 text-right">{naira(sheet.breakdown.supportPiecework)}</td>
                <td className="px-2 py-2 text-right">{naira(sheet.breakdown.overtime)}</td>
                <td className="px-2 py-2 text-right">{naira(sheet.breakdown.other)}</td>
                <td className="px-2 py-2 text-right">{naira(sheet.totals.due)}</td>
                <td className="px-2 py-2 text-right">{naira(sheet.totals.paid)}</td>
                <td className="px-2 py-2 text-right">{naira(sheet.totals.balance)}</td>
                <td className="px-2 py-2" />
              </tr>
            </tfoot>
          </table>
        )}

        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="border-b border-[#c9c3b2] pb-6 text-[11px] uppercase tracking-wide text-[#6b6250]">
              Prepared by (date)
            </p>
          </div>
          <div>
            <p className="border-b border-[#c9c3b2] pb-6 text-[11px] uppercase tracking-wide text-[#6b6250]">
              Approved by (date)
            </p>
          </div>
        </div>

        <p className="mt-6 text-[10px] leading-relaxed text-[#6b6250]">
          Piecework and support-work amounts are calculated from inspected and approved pieces only; submitted,
          reworked or rejected work is never payable. This sheet is confidential Matesther payroll information and is
          intended for the Owner and Matesther&apos;s bank.
        </p>
      </Letterhead>
    </main>
  );
}
