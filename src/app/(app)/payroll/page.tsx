"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
import { useAuth } from "@/lib/auth";

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
  const { user } = useAuth();
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

  function load() {
    setLoading(true);
    Promise.all([
      fetch(`/api/payroll?month=${month}`, { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/workers", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([p, w]) => {
        if (p.error) setErr(p.error);
        else setD(p);
        setWorkers(Array.isArray(w) ? w : []);
      })
      .finally(() => setLoading(false));
  }
  useEffect(load, [month]);

  function pickPayWorker(id: string) {
    const row = d?.workers.find((w: any) => String(w.workerId) === id);
    setPayForm({
      workerId: id,
      pieceworkAmount: row ? String(row.piecework) : "",
      supportAmount: row ? String(row.supportPiecework ?? 0) : "",
      salaryAmount: row ? String(row.salary) : "",
      overtimeAmount: row ? String(row.overtime) : "",
      otherAmount: row ? String(row.other ?? 0) : "",
      amount: row ? String(row.due) : "",
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
            ...payForm,
            kind,
            workerId: Number(payForm.workerId),
            periodMonth: month,
            paidBy: user?.name,
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
        subtitle="Monthly payroll - piecework on approved work, monthly salaries and overtime. This is part of the month's expenses."
        action={
          <>
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
            <StatCard label="Expected to Pay (this month)" value={naira(d.totals.due)} icon={<HandCoins className="w-5 h-5" />} tone="gold" sub={`${d.workers.filter((w: any) => w.due > 0).length} workers with earnings`} />
            <StatCard label="Already Paid" value={naira(d.totals.paid)} icon={<HandCoins className="w-5 h-5" />} tone="green" />
            <StatCard label="Still Owed" value={naira(d.totals.balance)} icon={<HandCoins className="w-5 h-5" />} tone={d.totals.balance > 0 ? "red" : "green"} sub={d.totals.balance > 0 ? "Settle before month end" : "All settled ✓"} />
            <StatCard label="Piecework Share" value={naira(d.workers.reduce((s: number, w: any) => s + w.piecework, 0))} icon={<HandCoins className="w-5 h-5" />} tone="blue" sub="Approved pieces × rate" />
          </div>
        )}
      </Card>

      {/* Payroll table */}
      <Card className="mb-4">
        <CardHeader title={`Who worked what - ${monthLabel(month)}`} subtitle="Pieceworkers earn only when their work is inspected & approved" />
        {loading ? (
          <Loading />
        ) : d?.workers.filter((w: any) => w.due > 0 || w.paid > 0).length === 0 ? (
          <EmptyState title={`No earnings recorded for ${monthLabel(month)}`} hint="Piecework appears here as soon as work is inspected; salaries appear for monthly staff." />
        ) : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[1180px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Worker</th>
                  <th className="px-3 py-3">Pay Type</th>
                  <th className="px-3 py-3 text-right">Pieces Approved</th>
                  <th className="px-3 py-3 text-right">Piecework</th>
                  <th className="px-3 py-3 text-right">Support</th>
                  <th className="px-3 py-3 text-right">Salary</th>
                  <th className="px-3 py-3 text-right">Overtime</th>
                  <th className="px-3 py-3 text-right">Other</th>
                  <th className="px-3 py-3 text-right">Total Due</th>
                  <th className="px-3 py-3 text-right">Paid</th>
                  <th className="px-3 py-3 text-right">Balance</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {d?.workers
                  .filter((w: any) => w.due > 0 || w.paid > 0)
                  .map((w: any) => (
                    <tr key={w.workerId} className="hover:bg-slate-50">
                      <td className="px-5 py-3 font-semibold">
                        {w.name}
                        <span className="block text-xs font-normal text-slate-500">{w.specialty} • {w.paymentType === "PER_PIECE" ? "Agreed rate varies by job" : `${naira(w.rate)} / month`}</span>
                      </td>
                      <td className="px-3 py-3 text-xs">{w.paymentType.replace("_", " ")}</td>
                      <td className="px-3 py-3 text-right">{w.pieces.toLocaleString()}</td>
                      <td className="px-3 py-3 text-right">{w.piecework ? naira(w.piecework) : "-"}</td>
                      <td className="px-3 py-3 text-right">{w.supportPiecework ? naira(w.supportPiecework) : "-"}</td>
                      <td className="px-3 py-3 text-right">{w.salary ? naira(w.salary) : "-"}</td>
                      <td className="px-3 py-3 text-right">{w.overtime ? naira(w.overtime) : "-"}</td>
                      <td className="px-3 py-3 text-right">{w.other ? naira(w.other) : "-"}</td>
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
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        {w.balance > 0 && (
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
                    <td colSpan={8} className="px-5 py-3 font-bold">Total - {monthLabel(month)}</td>
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
            Breakdown is pre-filled from their approved work, salary and overtime - adjust if part of it is paid.
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
              {(historyFor.roles ?? [historyFor.specialty]).join(", ")} • {historyFor.paymentType === "PER_PIECE" ? "Per-piece rates agreed by job" : `${historyFor.paymentType.replace("_", " ")} ${naira(historyFor.rate)} per month`}
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
                    <th className="px-3 py-2.5 text-right">Due</th>
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
