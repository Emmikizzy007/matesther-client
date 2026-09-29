"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Search, Pencil, Trash2 } from "lucide-react";
import { Card, CardHeader, PageHeader, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira, fmtDate, EXPENSE_CATEGORIES } from "@/lib/format";

export default function ExpensesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [orderF, setOrderF] = useState("");
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ orderId: "", category: "Labour", description: "", amount: "", expenseDate: new Date().toISOString().slice(0, 10), notes: "" });
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([
      fetch("/api/expenses", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/orders", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([e, o]) => {
        setRows(Array.isArray(e) ? e : []);
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
      const res = await fetch("/api/expenses", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, id: editing?.id, orderId: form.orderId || null, amount: Number(form.amount) }),
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
    if (!confirm("Delete this expense? The order's profit will be recalculated.")) return;
    await fetch(`/api/expenses?id=${id}`, { method: "DELETE" });
    load();
  }

  const filtered = rows.filter(
    (x) =>
      (!cat || x.category === cat) &&
      (!orderF || String(x.orderId) === orderF) &&
      x.description.toLowerCase().includes(q.toLowerCase())
  );
  const total = filtered.reduce((s, x) => s + (x.amount ?? 0), 0);
  const byCat = EXPENSE_CATEGORIES.map((c) => ({
    category: c,
    amount: rows.filter((x) => x.category === c).reduce((s, x) => s + (x.amount ?? 0), 0),
  })).filter((x) => x.amount > 0);
  const maxCat = Math.max(1, ...byCat.map((x) => x.amount));

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle={`Every naira Matesther spends - total ${naira(rows.reduce((s, x) => s + (x.amount ?? 0), 0))}`}
        action={
          <Btn onClick={() => { setEditing(null); setForm({ orderId: "", category: "Labour", description: "", amount: "", expenseDate: new Date().toISOString().slice(0, 10), notes: "" }); setErr(""); setModal(true); }}>
            <Plus className="w-4 h-4" /> Add Expense
          </Btn>
        }
      />

      <Card className="mb-4">
        <CardHeader title="Spending by category" />
        <div className="p-5 grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {byCat.map((c) => (
            <div key={c.category} className="border border-slate-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-slate-500">{c.category}</p>
              <p className="text-lg font-bold">{naira(c.amount)}</p>
              <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-matesther-700 rounded-full" style={{ width: `${Math.round((c.amount / maxCat) * 100)}%` }} />
              </div>
            </div>
          ))}
          {byCat.length === 0 && <p className="text-sm text-slate-500">No expenses yet.</p>}
        </div>
      </Card>

      <Card className="mb-4 p-3 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search expenses…" className={`${inputCls} pl-9`} />
        </div>
        <select value={cat} onChange={(e) => setCat(e.target.value)} className={`${inputCls} w-auto`}>
          <option value="">All categories</option>
          {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={orderF} onChange={(e) => setOrderF(e.target.value)} className={`${inputCls} w-auto`}>
          <option value="">All orders</option>
          {orders.map((o) => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
        </select>
      </Card>

      <Card>
        {loading ? <Loading /> : filtered.length === 0 ? <EmptyState title="No expenses found" /> : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[840px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-3 py-3">Description</th>
                  <th className="px-3 py-3">Category</th>
                  <th className="px-3 py-3">Order</th>
                  <th className="px-3 py-3 text-right">Amount</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((x) => (
                  <tr key={x.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 whitespace-nowrap">{fmtDate(x.expenseDate)}</td>
                    <td className="px-3 py-3 font-medium">{x.description}{x.notes && <span className="block text-xs font-normal text-slate-500">{x.notes}</span>}</td>
                    <td className="px-3 py-3">{x.category}</td>
                    <td className="px-3 py-3">
                      {x.orderId ? (
                        <Link href={`/orders/${x.orderId}`} className="text-matesther-700 hover:underline font-medium">{x.orderNumber}</Link>
                      ) : (
                        <span className="text-slate-400">General</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-bold">{naira(x.amount)}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => {
                          setEditing(x);
                          setForm({ orderId: x.orderId ? String(x.orderId) : "", category: x.category, description: x.description, amount: String(x.amount), expenseDate: x.expenseDate, notes: x.notes || "" });
                          setErr("");
                          setModal(true);
                        }}
                        className="p-1.5 text-slate-500 hover:text-matesther-700"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => del(x.id)} className="p-1.5 text-slate-500 hover:text-red-700">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50">
                  <td colSpan={4} className="px-5 py-3 font-bold">Total ({filtered.length} expenses)</td>
                  <td className="px-3 py-3 text-right font-bold">{naira(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? "Edit Expense" : "Add Expense"}>
        <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
          <Field label="Attach to order (optional)">
            <select value={form.orderId} onChange={(e) => setForm({ ...form, orderId: e.target.value })} className={inputCls}>
              <option value="">General (not tied to an order)</option>
              {orders.filter((o) => o.status !== "CANCELLED").map((o) => <option key={o.id} value={o.id}>{o.orderNumber} - {o.customer}</option>)}
            </select>
          </Field>
          <Field label="Category">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Description *" className="sm:col-span-2">
            <input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} placeholder="e.g. Sewing labour - 250 shirts" />
          </Field>
          <Field label="Amount (₦) *"><input type="number" min="1" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputCls} /></Field>
          <Field label="Date"><input type="date" value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} className={inputCls} /></Field>
          <Field label="Notes" className="sm:col-span-2"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputCls} /></Field>
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Expense"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
