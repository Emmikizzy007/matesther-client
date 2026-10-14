"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, HandCoins, History, Plus, Printer } from "lucide-react";
import {
  Card,
  CardHeader,
  PageHeader,
  StatCard,
  Badge,
  Loading,
  EmptyState,
  Modal,
  Field,
  inputCls,
  Btn,
} from "@/components/ui";
import { naira, fmtDate } from "@/lib/format";

const PAY_METHODS = ["Cash", "Bank Transfer", "POS", "Other"];

function monthKey(d: Date | string) {
  return d instanceof Date ? d.toISOString().slice(0, 7) : String(d).slice(0, 7);
}
function shiftMonth(key: string, delta: number) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function PayrollPage() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [d, setD] = useState<any>(null);
  const [workers, setWorkers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [payModal, setPayModal] = useState<any>(null);
  const [payForm, setPayForm] = useState({ workerId: "", pieceworkAmount: "", supportAmount: "", salaryAmount: "", overtimeAmount: "", otherAmount: "", amount: "", method: "Bank Transfer", paymentDate: new Date().toISOString().slice(0, 10), reference: "", notes: "" });
  const [otModal, setOtModal] = useState(false);
  const [otForm, setOtForm] = useState({ workerId: "", workedOn: new Date().toISOString().slice(0, 10), hours: "", amount: "", category: "OVERTIME", notes: "" });
  const [historyFor, setHistoryFor] = useState<any>(null);
  const [formErr, setFormErr] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/payroll?month=${month}`, { cache: "no-store" }).then((r) => r.json())
      .then((p) => {
        if (p.error) setErr(p.error);
        else { setErr(""); setD(p); setWorkers(p.workers.map((w: any) => ({ id: w.workerId, name: w.name, specialty: w.specialty, status: w.status }))); }
      })
      .catch((cause) => setErr(cause instanceof Error ? cause.message : "Could not load payroll."))
      .finally(() => setLoading(false));
  }, [month]);
  useEffect(() => {
    // Loading happens in the queued callback, not synchronously during render's
    // effect setup; the same loader is reused after cash settlements.
    const id = window.setTimeout(load, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  function pickPayWorker(id: string) {
    const row = d?.workers.find((w: any) => String(w.workerId) === id);
    // Existing breakdown fields describe a CASH settlement, not the gross wage
    // before a helper share, PAYE or savings. For a net-of-deductions or partial
    // payment leave them blank; the immutable statement holds the calculation.
    const simpleFullPay = row && row.paid === 0 && row.totalDeductions === 0;
    setPayForm({
      workerId: id,
      pieceworkAmount: simpleFullPay ? String(row.piecework) : "",
      supportAmount: simpleFullPay ? String(row.supportPiecework ?? 0) : "",
      salaryAmount: simpleFullPay ? String(row.salary) : "",
      overtimeAmount: simpleFullPay ? String(row.overtime) : "",
      otherAmount: simpleFullPay ? String(row.other ?? 0) : "",
      amount: row ? String(row.balance) : "",
      method: "Bank Transfer",
      paymentDate: new Date().toISOString().slice(0, 10),
      reference: "",
      notes: "",
    });
  }

  async function submit(kind: "payment" | "overtime", e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormErr("");
    try {
      const body = kind === "payment"
        ? {
            ...Object.fromEntries(Object.entries(payForm).filter(([key, value]) =>
              !["pieceworkAmount", "supportAmount", "salaryAmount", "overtimeAmount", "otherAmount"].includes(key) || value !== "")),
            kind,
            workerId: Number(payForm.workerId),
            periodMonth: month,
            // Same worker, month, date, amount, method and reference can only be
            // recorded once, so a double click or a retried request cannot pay twice.
            idempotencyKey: `payroll:${month}:${payForm.workerId}:${payForm.paymentDate}:${Number(payForm.amount) || 0}:${payForm.method}:${payForm.reference}`.slice(0, 200),
          }
        : { ...otForm, kind: otForm.category === "OTHER" ? "other" : kind, workerId: Number(otForm.workerId) };
      const res = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setPayModal(null);
      setOtModal(false);
      load();
    } catch (e: any) {
      setFormErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(w: any) {
    setFormErr("");
    setHistoryFor({ name: w.name, loading: true });
    const res = await fetch(`/api/payroll?month=${month}&workerId=${w.workerId}`, { cache: "no-store" }).then((r) => r.json());
    setHistoryFor({ ...w, ...res, loading: false });
  }

  const payTotal = (Number(payForm.pieceworkAmount) || 0) + (Number(payForm.supportAmount) || 0) + (Number(payForm.salaryAmount) || 0) + (Number(payForm.overtimeAmount) || 0) + (Number(payForm.otherAmount) || 0);

  if (err) return <p className="text-sm text-red-700">Failed to load: {err}</p>;

  return (
    <div>
      <PageHeader
        title="Worker Payments"
        subtitle="Monthly payroll: approved production, salary and overtime → itemized statutory/company deductions → net payable. Post completed months before paying workers with approved deductions."
        action={
          <>
            <Btn href="/payroll/deductions" variant="secondary">Payroll Deductions</Btn>
            <Link href={`/payment-sheet/${month}`} target="_blank" rel="noreferrer">
              <Btn variant="secondary"><Printer className="w-4 h-4" /> Bank Payment Sheet</Btn>
            </Link>
            <Btn onClick={() => { setFormErr(""); setOtForm({ workerId: "", workedOn: new Date().toISOString().slice(0, 10), hours: "", amount: "", category: "OVERTIME", notes: "" }); setOtModal(true); }}>
              <Plus className="w-4 h-4" /> Overtime / Other
            </Btn>
          </>
        }
      />

      {/* Month switcher + summary */}
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setMonth(shiftMonth(month, -1))} className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-50"><ChevronLeft className="w-4 h-4" /></button>
            <p className="font-bold text-lg min-w-[170px] text-center">{monthLabel(month)}</p>
            <button
              onClick={() => setMonth(shiftMonth(month, 1))}
              disabled={month >= monthKey(new Date())}
              className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {month < monthKey(new Date()) ? "Past month - historical records" : "Current month - amounts update as work gets inspected"}
          </p>
        </div>
        {d && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            <StatCard label="Net Preview / Posted (this month)" value={naira(d.totals.due)} icon={<HandCoins className="w-5 h-5" />} tone="gold" sub={`${d.workers.filter((w: any) => w.due > 0).length} workers with earnings`} />
            <StatCard label="All Deductions" value={naira(d.breakdown?.totalDeductions ?? 0)} icon={<HandCoins className="w-5 h-5" />} tone="red" sub="Helper allocation + approved PAYE + company deductions (preview or posted)" />
            <StatCard label="Already Paid" value={naira(d.totals.paid)} icon={<HandCoins className="w-5 h-5" />} tone="green" />
            <StatCard label="Still Owed" value={naira(d.totals.balance)} icon={<HandCoins className="w-5 h-5" />} tone={d.totals.balance > 0 ? "red" : "green"} sub={d.totals.balance > 0 ? "Settle before month end" : "All settled ✓"} />
            <StatCard label="Piecework Share" value={naira(d.workers.reduce((s: number, w: any) => s + w.piecework, 0))} icon={<HandCoins className="w-5 h-5" />} tone="blue" sub="Approved pieces × rate — gross, before any support deduction" />
            {/*
              Both sides of delegated support work, side by side. Matesther pays the helper
              directly, and takes the same amount back out of the commission of the tailor
              who handed the work over — so these two figures are the SAME money, and the
              order's labour cost does not rise by either of them. Showing only one side
              is what made support labour look like an extra cost.
            */}
            <StatCard
              label="Support Paid to Helpers"
              value={naira(d.breakdown?.supportPiecework ?? 0)}
              icon={<HandCoins className="w-5 h-5" />}
              tone="green"
              sub={`${d.workers.filter((w: any) => (w.supportPieces ?? 0) > 0).length} helpers on approved pieces`}
            />
            <StatCard
              label="Deducted from Tailors"
              value={naira(d.breakdown?.supportDeduction ?? 0)}
              icon={<HandCoins className="w-5 h-5" />}
              tone="red"
              sub={
                (d.breakdown?.supportDeductionOwed ?? 0) > 0
                  ? `${naira(d.breakdown.supportDeductionOwed)} more held against a tailor with no commission this month — carried forward, never written off`
                  : "The same money as the line above, not an extra cost"
              }
            />
          </div>
        )}
      </Card>

      {/* Payroll table */}
      <Card className="mb-4">
        <CardHeader title={`Who worked what - ${monthLabel(month)}`} subtitle="Pieceworkers earn only when their work is inspected & approved" />
        {loading ? (
          <Loading />
        ) : d?.workers.filter((w: any) => w.due > 0 || w.paid > 0 || w.deductionItems?.length).length === 0 ? (
          <EmptyState title={`No earnings recorded for ${monthLabel(month)}`} hint="Piecework appears here as soon as work is inspected; salaries appear for monthly staff." />
        ) : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[1180px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Worker</th>
                  <th className="px-3 py-3">Pay Type</th>
                  <th className="px-3 py-3 text-right">Pieces Approved</th>
                  <th className="px-3 py-3 text-right" title="Gross commission on approved pieces, before any support deduction">Piecework (gross)</th>
                  <th className="px-3 py-3 text-right">Support Earned</th>
                  <th className="px-3 py-3 text-right">Support Deduction</th>
                  <th className="px-3 py-3 text-right">Salary</th>
                  <th className="px-3 py-3 text-right">Overtime</th>
                  <th className="px-3 py-3 text-right">Other</th>
                  <th className="px-3 py-3 text-right">Gross</th>
                  <th className="px-3 py-3 text-right">PAYE / Other Deductions</th>
                  <th className="px-3 py-3 text-right">Net Due</th>
                  <th className="px-3 py-3 text-right">Paid</th>
                  <th className="px-3 py-3 text-right">Balance</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {d?.workers
                  .filter((w: any) => w.due > 0 || w.paid > 0 || w.deductionItems?.length)
                  .map((w: any) => (
                    <tr key={w.workerId} className="hover:bg-slate-50">
                      <td className="px-5 py-3 font-semibold">
                        {w.name}
                        <span className="block text-xs font-normal text-slate-500">{w.specialty} • {w.paymentType === "HYBRID" ? `${naira(w.rate)} monthly + approved pieces` : w.paymentType === "PER_PIECE" ? "Agreed rate varies by job" : `${naira(w.rate)} / month`}</span>
                      </td>
                      <td className="px-3 py-3 text-xs">{w.paymentType.replace("_", " ")}</td>
                      <td className="px-3 py-3 text-right">{w.pieces.toLocaleString()}</td>
                      <td className="px-3 py-3 text-right">{w.piecework ? naira(w.piecework) : "-"}</td>
                      <td className="px-3 py-3 text-right" title="Pieces this person was handed by a tailor, approved, and paid for directly by Matesther">
                        {w.supportPiecework ? naira(w.supportPiecework) : "-"}
                        {(w.supportPieces ?? 0) > 0 && (
                          <span className="block text-[11px] font-normal text-slate-400">{w.supportPieces} pcs delegated to them</span>
                        )}
                      </td>
                      {/*
                        What came OUT of this person's own commission because they handed
                        work to a helper. Without this column the Piecework figure (gross)
                        and Total Due (net) disagree on screen with nothing to explain the
                        difference.
                      */}
                      <td className="px-3 py-3 text-right">
                        {w.supportDeduction ? <span className="text-red-600">−{naira(w.supportDeduction)}</span> : "-"}
                        {(w.supportPiecesDelegated ?? 0) > 0 && (
                          <span className="block text-[11px] font-normal text-slate-400">
                            {w.supportPiecesDelegated} pcs they handed out
                          </span>
                        )}
                        {(w.supportDeductionOwed ?? 0) > 0 && (
                          <span
                            className="block text-[11px] font-semibold text-amber-700"
                            title="This tailor had no piece-rate commission this month to deduct from. The amount is held and carried forward to the next month that has commission — it is never written off, and it never makes a balance negative."
                          >
                            +{naira(w.supportDeductionOwed)} carried forward
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">{w.salary ? naira(w.salary) : "-"}</td>
                      <td className="px-3 py-3 text-right">{w.overtime ? naira(w.overtime) : "-"}</td>
                      <td className="px-3 py-3 text-right">{w.other ? naira(w.other) : "-"}</td>
                      <td className="px-3 py-3 text-right">{naira(w.gross)}</td>
                      <td className="px-3 py-3 text-right">
                        {w.payrollDeductions ? <span className={w.payrollDeductions < 0 ? "text-emerald-700" : "text-red-700"}>
                          {w.payrollDeductions < 0 ? `+${naira(-w.payrollDeductions)} refund` : `−${naira(w.payrollDeductions)}`}
                        </span> : "-"}
                        {w.deductionItems?.map((item: any) => <span key={`${item.id}-${item.categoryCode}`} className="block text-[11px] text-slate-500" title={item.calculation}>
                          {item.categoryName}: {item.amount < 0 ? `+${naira(-item.amount)}` : `−${naira(item.amount)}`}
                        </span>)}
                        {w.previewIssues?.map((issue: string, i: number) => <span key={i} className="block text-[11px] font-semibold text-red-700" title={issue}>Blocked: {issue}</span>)}
                        {!w.finalized && w.mustPost && !w.previewIssues?.length && <span className="block text-[11px] text-amber-700">Preview · post before payment</span>}
                      </td>
                      <td className="px-3 py-3 text-right font-bold">{naira(w.due)}</td>
                      <td className="px-3 py-3 text-right text-matesther-700 font-semibold">{w.paid ? naira(w.paid) : "-"}</td>
                      <td className="px-3 py-3 text-right font-bold">
                        {w.balance > 0 ? <span className="text-red-700">{naira(w.balance)}</span> : w.paid > 0 ? <span className="text-emerald-700">Settled</span> : "-"}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {w.paymentStatus === "PAID" ? <span className="font-semibold text-emerald-700">Paid in full</span>
                          : w.paymentStatus === "PARTIAL" ? <span className="font-semibold text-amber-700">Part paid</span>
                          : w.paymentStatus === "UNPAID" ? <span className="font-semibold text-red-700">Not yet paid</span>
                          : <span className="text-slate-400">Nothing due</span>}
                        {w.finalized && <span className="block text-[11px] font-semibold text-emerald-700">Posted #{w.statementId}</span>}
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        {w.mustPost && !w.finalized && <Link href="/payroll/deductions" className="text-xs font-bold text-amber-800 hover:underline mr-3">Review → Post</Link>}
                        {w.balance > 0 && !(w.mustPost && !w.finalized) && (
                          <button
                            onClick={() => { setFormErr(""); pickPayWorker(String(w.workerId)); setPayModal(w); }}
                            className="text-xs font-bold text-matesther-700 hover:underline mr-3"
                          >
                            Pay
                          </button>
                        )}
                        <button onClick={() => openHistory(w)} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-matesther-700">
                          <History className="w-3.5 h-3.5" /> History
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                {d && (
                  <tr className="border-t-2 border-slate-200 bg-slate-50">
                    <td colSpan={9} className="px-5 py-3 font-bold">Total - {monthLabel(month)}</td>
                    <td className="px-3 py-3 text-right font-bold">{naira(d.breakdown?.gross ?? 0)}</td>
                    <td className="px-3 py-3 text-right font-bold text-red-700">{(d.breakdown?.payrollDeductions ?? 0) < 0 ? `+${naira(-d.breakdown.payrollDeductions)} refunds` : `−${naira(d.breakdown?.payrollDeductions ?? 0)}`}</td>
                    <td className="px-3 py-3 text-right font-extrabold">{naira(d.totals.due)}</td>
                    <td className="px-3 py-3 text-right font-bold text-matesther-700">{naira(d.totals.paid)}</td>
                    <td className="px-3 py-3 text-right font-extrabold text-red-700">{naira(d.totals.balance)}</td>
                    <td />
                    <td />
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <div className="grid xl:grid-cols-2 gap-4">
        {/* Payments made this month */}
        <Card>
          <CardHeader title={`Payments Made - ${monthLabel(month)}`} />
          <div className="divide-y divide-slate-100">
            {d?.payments.map((p: any) => (
              <div key={p.id} className="px-5 py-3 text-sm flex justify-between items-center">
                <div>
                  <p className="font-semibold">{p.workerName} - {naira(p.amount)}</p>
                  <p className="text-xs text-slate-500">
                    {fmtDate(p.paymentDate)} • {p.method}{p.paidBy ? ` • by ${p.paidBy}` : ""}
                    {p.notes ? ` • ${p.notes}` : ""}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Piecework {naira(p.pieceworkAmount)} + Support {naira(p.supportAmount ?? 0)} + Salary {naira(p.salaryAmount)} + Overtime {naira(p.overtimeAmount)} + Other {naira(p.otherAmount ?? 0)}
                    {p.reference ? ` • Ref ${p.reference}` : ""}
                  </p>
                </div>
                <Badge status="COMPLETED" />
              </div>
            ))}
            {(!d || d.payments.length === 0) && <EmptyState title="No payments recorded this month" hint="Use “Pay” on a worker's row to record a settlement." />}
          </div>
        </Card>

        {/* Overtime this month */}
        <Card>
          <CardHeader title={`Overtime & Other Payments - ${monthLabel(month)}`} />
          <div className="divide-y divide-slate-100">
            {d?.overtime.map((o: any) => (
              <div key={o.id} className="px-5 py-3 text-sm flex justify-between items-center">
                <div>
                  <p className="font-semibold">{o.workerName} - {naira(o.amount)}</p>
                  <p className="text-xs text-slate-500">{o.category === "OTHER" ? "Other payment" : "Overtime"} • {fmtDate(o.workedOn)} • {o.hours ? `${o.hours} hrs` : ""}{o.notes ? ` • ${o.notes}` : ""}</p>
                </div>
                <Badge status="IN_PROGRESS" />
              </div>
            ))}
            {(!d || d.overtime.length === 0) && <EmptyState title="No overtime recorded this month" />}
          </div>
        </Card>
      </div>

      {/* Pay modal */}
      <Modal open={!!payModal} onClose={() => setPayModal(null)} title={payModal ? `Pay - ${payModal.name}` : ""}>
        <form onSubmit={(e) => submit("payment", e)} className="grid sm:grid-cols-2 gap-3">
          <p className="sm:col-span-2 text-xs text-slate-500 bg-matesther-50 border border-matesther-100 rounded-lg px-3 py-2">
            Settling {monthLabel(month)} for <span className="font-semibold">{payModal?.name}</span>.
            Breakdown fields describe only the CASH settlement. For a posted net-of-deductions payment they start blank: the posted statement above holds the gross, each deduction and the net. If you fill any settlement breakdown fields, their sum must equal the amount paid now.
          </p>
          <Field label="Production piecework"><input type="number" min="0" value={payForm.pieceworkAmount} onChange={(e) => setPayForm({ ...payForm, pieceworkAmount: e.target.value })} className={inputCls} /></Field>
          <Field label="Support work piecework"><input type="number" min="0" value={payForm.supportAmount} onChange={(e) => setPayForm({ ...payForm, supportAmount: e.target.value })} className={inputCls} /></Field>
          <Field label="Salary"><input type="number" min="0" value={payForm.salaryAmount} onChange={(e) => setPayForm({ ...payForm, salaryAmount: e.target.value })} className={inputCls} /></Field>
          <Field label="Overtime"><input type="number" min="0" value={payForm.overtimeAmount} onChange={(e) => setPayForm({ ...payForm, overtimeAmount: e.target.value })} className={inputCls} /></Field>
          <Field label="Other payments"><input type="number" min="0" value={payForm.otherAmount} onChange={(e) => setPayForm({ ...payForm, otherAmount: e.target.value })} className={inputCls} /></Field>
          <Field label="Total breakdown"><input value={naira(payTotal)} disabled className={`${inputCls} bg-slate-100`} /></Field>
          <Field label="Amount to pay now (₦) *"><input type="number" min="1" required value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} className={inputCls} /></Field>
          <Field label="Payment date"><input type="date" value={payForm.paymentDate} onChange={(e) => setPayForm({ ...payForm, paymentDate: e.target.value })} className={inputCls} /></Field>
          <Field label="Method">
            <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className={inputCls}>
              {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Bank / transfer reference"><input value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} className={inputCls} placeholder="Shown on the payment sheet" /></Field>
          <Field label="Notes"><input value={payForm.notes} onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })} className={inputCls} placeholder="e.g. Full September settlement" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setPayModal(null)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Payment"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Overtime modal */}
      <Modal open={otModal} onClose={() => setOtModal(false)} title="Record Overtime or Other Payment">
        <form onSubmit={(e) => submit("overtime", e)} className="grid sm:grid-cols-2 gap-3">
          <Field label="Type" className="sm:col-span-2">
            <select value={otForm.category} onChange={(e) => setOtForm({ ...otForm, category: e.target.value })} className={inputCls}>
              <option value="OVERTIME">Overtime</option>
              <option value="OTHER">Other approved payment (allowance, bonus)</option>
            </select>
          </Field>
          <Field label="Worker *">
            <select required value={otForm.workerId} onChange={(e) => setOtForm({ ...otForm, workerId: e.target.value })} className={inputCls}>
              <option value="">Select…</option>
              {workers.filter((w) => w.status === "ACTIVE").map((w) => <option key={w.id} value={w.id}>{w.name} - {w.specialty}</option>)}
            </select>
          </Field>
          <Field label="Worked on"><input type="date" value={otForm.workedOn} onChange={(e) => setOtForm({ ...otForm, workedOn: e.target.value })} className={inputCls} /></Field>
          {otForm.category === "OVERTIME" && (
            <Field label="Hours (for record)"><input type="number" min="0" value={otForm.hours} onChange={(e) => setOtForm({ ...otForm, hours: e.target.value })} className={inputCls} /></Field>
          )}
          <Field label="Amount paid (₦) *"><input type="number" min="1" required value={otForm.amount} onChange={(e) => setOtForm({ ...otForm, amount: e.target.value })} className={inputCls} /></Field>
          <Field label="Notes" className="sm:col-span-2"><input value={otForm.notes} onChange={(e) => setOtForm({ ...otForm, notes: e.target.value })} className={inputCls} placeholder="e.g. Rush job for school delivery" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setOtModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : otForm.category === "OTHER" ? "Record Payment" : "Record Overtime"}</Btn>
          </div>
        </form>
      </Modal>

      {/* History modal */}
      <Modal open={!!historyFor} onClose={() => setHistoryFor(null)} title={historyFor ? `${historyFor.name} - 12 month history` : ""} wide>
        {historyFor?.loading ? (
          <Loading />
        ) : historyFor?.history ? (
          <div>
            <p className="text-xs text-slate-500 mb-3">
              {(historyFor.roles ?? [historyFor.specialty]).join(", ")} • {historyFor.paymentType === "HYBRID" ? `${naira(historyFor.rate)} monthly plus agreed piece rates` : historyFor.paymentType === "PER_PIECE" ? "Per-piece rates agreed by job" : `${historyFor.paymentType.replace("_", " ")} ${naira(historyFor.rate)} per month`}
            </p>
            <div className="overflow-x-auto slim-scroll rounded-lg border border-slate-200">
              <table className="w-full text-sm min-w-[700px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100 bg-slate-50">
                    <th className="px-4 py-2.5">Month</th>
                    <th className="px-3 py-2.5 text-right">Pieces</th>
                    <th className="px-3 py-2.5 text-right">Piecework</th>
                    <th className="px-3 py-2.5 text-right">Support</th>
                    <th className="px-3 py-2.5 text-right">Salary</th>
                    <th className="px-3 py-2.5 text-right">Overtime</th>
                    <th className="px-3 py-2.5 text-right">Other</th>
                    <th className="px-3 py-2.5 text-right">Deductions</th>
                    <th className="px-3 py-2.5 text-right">Net Due</th>
                    <th className="px-3 py-2.5 text-right">Paid</th>
                    <th className="px-3 py-2.5 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {historyFor.history.map((h: any) => (
                    <tr key={h.month} className={h.due === 0 && h.paid === 0 ? "opacity-40" : "hover:bg-slate-50"}>
                      <td className="px-4 py-2 font-medium">{monthLabel(h.month)}</td>
                      <td className="px-3 py-2 text-right">{h.pieces.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right">{h.piecework ? naira(h.piecework) : "-"}</td>
                      <td className="px-3 py-2 text-right">{h.supportPiecework ? naira(h.supportPiecework) : "-"}</td>
                      <td className="px-3 py-2 text-right">{h.salary ? naira(h.salary) : "-"}</td>
                      <td className="px-3 py-2 text-right">{h.overtime ? naira(h.overtime) : "-"}</td>
                      <td className="px-3 py-2 text-right">{h.other ? naira(h.other) : "-"}</td>
                      <td className="px-3 py-2 text-right">{h.totalDeductions ? naira(h.totalDeductions) : "-"}
                        {h.deductionItems?.map((item: any) => <span className="block text-[11px] text-slate-500" key={item.id}>{item.categoryName}: {item.amount < 0 ? "+" : "−"}{naira(Math.abs(item.amount))}</span>)}
                        {h.finalized && <span className="block text-[11px] text-emerald-700">Posted #{h.statementId}</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-bold">{naira(h.due)}</td>
                      <td className="px-3 py-2 text-right text-matesther-700 font-semibold">{h.paid ? naira(h.paid) : "-"}</td>
                      <td className="px-3 py-2 text-right font-semibold">{h.balance > 0 ? <span className="text-red-700">{naira(h.balance)}</span> : h.paid > 0 ? <span className="text-emerald-700">Settled</span> : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {historyFor.payments.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase text-slate-500 mb-2">Payment records</p>
                <div className="space-y-2 max-h-40 overflow-y-auto slim-scroll">
                  {historyFor.payments.map((p: any) => (
                    <div key={p.id} className="text-xs border border-slate-200 rounded-lg px-3 py-2 flex justify-between">
                      <span>{fmtDate(p.paymentDate)} • {p.method}{p.paidBy ? ` • by ${p.paidBy}` : ""}{p.notes ? ` • ${p.notes}` : ""}</span>
                      <span className="font-bold">{naira(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
