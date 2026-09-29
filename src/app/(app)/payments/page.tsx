"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Search, Trash2 } from "lucide-react";
import { Card, CardHeader, PageHeader, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira, fmtDate, PAYMENT_METHODS } from "@/lib/format";

export default function PaymentsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [method, setMethod] = useState("");
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ orderId: "", amount: "", paymentDate: new Date().toISOString().slice(0, 10), paymentMethod: "Bank Transfer", reference: "", notes: "" });
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([
      fetch("/api/payments", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/orders", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([p, o]) => {
        setRows(Array.isArray(p) ? p : []);
        setOrders(Array.isArray(o) ? o : []);
      })
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, orderId: Number(form.orderId), amount: Number(form.amount) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to save");
      setModal(false);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function del(id: number) {
    if (!confirm("Delete this payment? The order balance will be recalculated.")) return;
    await fetch(`/api/payments?id=${id}`, { method: "DELETE" });
    load();
  }

  const filtered = rows.filter(
    (p) =>
      (!method || p.paymentMethod === method) &&
      (p.customer.toLowerCase().includes(q.toLowerCase()) ||
        p.orderNumber.toLowerCase().includes(q.toLowerCase()) ||
        (p.reference || "").toLowerCase().includes(q.toLowerCase()))
  );
  const collected = rows.reduce((s, p) => s + (p.amount ?? 0), 0);
  const outstanding = orders.filter((o) => o.status !== "CANCELLED").reduce((s, o) => s + Math.max(0, o.balance ?? 0), 0);
  const owing = orders.filter((o) => (o.balance ?? 0) > 0 && o.status !== "CANCELLED");

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle="What schools have paid - and what they still owe Matesther"
        action={
          <Btn onClick={() => { setForm({ orderId: "", amount: "", paymentDate: new Date().toISOString().slice(0, 10), paymentMethod: "Bank Transfer", reference: "", notes: "" }); setErr(""); setModal(true); }}>
            <Plus className="w-4 h-4" /> Record Payment
          </Btn>
        }
      />

      <div className="grid md:grid-cols-3 gap-3 mb-4">
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total collected</p>
          <p className="text-2xl font-bold text-matesther-700">{naira(collected)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Outstanding balances</p>
          <p className="text-2xl font-bold text-amber-700">{naira(outstanding)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Orders with balance due</p>
          <p className="text-2xl font-bold">{owing.length}</p>
        </Card>
      </div>

      {owing.length > 0 && (
        <Card className="mb-4">
          <CardHeader title="Who still owes Matesther" />
          <div className="divide-y divide-slate-100">
            {owing.slice(0, 6).map((o) => (
              <div key={o.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <p>
                  <Link href={`/orders/${o.id}`} className="font-semibold text-matesther-800 hover:underline">{o.orderNumber}</Link>
                  <span className="text-slate-500"> • {o.customer} • paid {naira(o.amountPaid)} of {naira(o.totalAmount)}</span>
                </p>
                <p className="font-bold text-amber-700">{naira(o.balance)} due</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="mb-4 p-3 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer, order, reference…" className={`${inputCls} pl-9`} />
        </div>
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${inputCls} w-auto`}>
          <option value="">All methods</option>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Card>

      <Card>
        {loading ? <Loading /> : filtered.length === 0 ? <EmptyState title="No payments found" /> : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[840px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-3 py-3">Customer</th>
                  <th className="px-3 py-3">Order</th>
                  <th className="px-3 py-3">Method</th>
                  <th className="px-3 py-3">Reference</th>
                  <th className="px-3 py-3 text-right">Amount</th>
                  <th className="px-3 py-3 text-right">Order Balance</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 whitespace-nowrap">{fmtDate(p.paymentDate)}</td>
                    <td className="px-3 py-3 font-medium">{p.customer}</td>
                    <td className="px-3 py-3">
                      <Link href={`/orders/${p.orderId}`} className="text-matesther-700 hover:underline font-medium">{p.orderNumber}</Link>
                    </td>
                    <td className="px-3 py-3">{p.paymentMethod}</td>
                    <td className="px-3 py-3 text-xs text-slate-500">
                      {p.reference || "-"}
                      <a href={`/receipt/${p.id}`} target="_blank" rel="noreferrer" className="block font-semibold text-matesther-700 hover:underline">
                        Open receipt ↗
                      </a>
                    </td>
                    <td className="px-3 py-3 text-right font-bold text-matesther-700">{naira(p.amount)}</td>
                    <td className="px-3 py-3 text-right text-amber-700 font-semibold">{naira(p.balance)}</td>
                    <td className="px-3 py-3 text-right">
                      <button onClick={() => del(p.id)} className="p-1.5 text-slate-400 hover:text-red-700">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title="Record Customer Payment">
        <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
          <Field label="Order *">
            <select
              required
              value={form.orderId}
              onChange={(e) => {
                const o = orders.find((x) => String(x.id) === e.target.value);
                setForm({ ...form, orderId: e.target.value, amount: o && o.balance > 0 ? String(o.balance) : form.amount });
              }}
              className={inputCls}
            >
              <option value="">Select order…</option>
              {orders.filter((o) => o.status !== "CANCELLED").map((o) => (
                <option key={o.id} value={o.id}>{o.orderNumber} - {o.customer} (owes {naira(o.balance)})</option>
              ))}
            </select>
          </Field>
          <Field label="Amount (₦) *"><input type="number" min="1" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputCls} /></Field>
          <Field label="Payment date"><input type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} className={inputCls} /></Field>
          <Field label="Method">
            <select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })} className={inputCls}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Reference / receipt no"><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} className={inputCls} placeholder="MTH-REC-…" /></Field>
          <Field label="Notes"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputCls} placeholder="e.g. Second instalment" /></Field>
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Payment"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
