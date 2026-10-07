"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Search, Trash2 } from "lucide-react";
import {
  Card,
  PageHeader,
  Badge,
  ProgressBar,
  Loading,
  EmptyState,
  Modal,
  Field,
  inputCls,
  Btn,
} from "@/components/ui";
import { naira, fmtDate } from "@/lib/format";

interface Item { productId: string; quantity: string; unitPrice: string; notes: string }

const blankItem = (): Item => ({ productId: "", quantity: "", unitPrice: "", notes: "" });

/** How many orders one page of the list shows. */
const PAGE_SIZE = 25;

/**
 * How long to stop typing before a search is actually sent.
 *
 * The search is server-side now, so every keystroke would otherwise be a request -
 * and on a phone on a poor connection that is both slow and wasteful. Debouncing keeps
 * it to one request per pause in typing, which is what the previous client-side filter
 * cost the network (nothing) while costing the database everything.
 */
const SEARCH_DEBOUNCE_MS = 300;

export default function OrdersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  /** What was actually queried, as opposed to what is currently typed. */
  const [applied, setApplied] = useState({ search: "", status: "" });
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ customerId: "", orderDate: new Date().toISOString().slice(0, 10), dueDate: "", notes: "" });
  const [items, setItems] = useState<Item[]>([blankItem()]);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  /**
   * One page of orders, filtered in the DATABASE.
   *
   * This screen used to download every order in the business - with every order item,
   * batch and production operation behind it - and then filter that in the browser on
   * every keystroke. It now asks for one page with the search and status already
   * applied, and reads the matching total from `X-Total-Count` so the pager knows how
   * many pages exist without a second request.
   *
   * The catalogue for the New Order form (schools and garments) is fetched once and
   * kept, because it is genuinely needed whole to build an order and is small.
   */
  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (applied.search) params.set("search", applied.search);
    if (applied.status) params.set("status", applied.status);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(page * PAGE_SIZE));
    Promise.all([
      fetch(`/api/orders?${params.toString()}`, { cache: "no-store" }),
      fetch("/api/customers", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/products", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(async ([orderResponse, c, p]) => {
        const list = await orderResponse.json();
        setRows(Array.isArray(list) ? list : []);
        setTotal(Number(orderResponse.headers.get("X-Total-Count")) || (Array.isArray(list) ? list.length : 0));
        setCustomers(Array.isArray(c) ? c : []);
        setProducts(Array.isArray(p) ? p : []);
      })
      .catch(() => setErr("Could not load orders."))
      .finally(() => setLoading(false));
  }
  useEffect(load, [applied, page]);

  // Send the search once typing pauses, and go back to the first page when it changes:
  // page 3 of a narrower search is very often empty, which reads as "no orders found".
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(0);
      setApplied((current) => (current.search === q.trim() ? current : { ...current, search: q.trim() }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function pickProduct(idx: number, pid: string) {
    const p = products.find((x) => String(x.id) === pid);
    const next = [...items];
    next[idx] = { ...next[idx], productId: pid, unitPrice: p ? String(p.sellingPrice) : next[idx].unitPrice };
    setItems(next);
  }

  const estTotal = items.reduce(
    (s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0),
    0
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const clean = items.filter((i) => i.productId && Number(i.quantity) > 0);
      if (!form.customerId) throw new Error("Select a customer (school).");
      if (clean.length === 0) throw new Error("Add at least one uniform product with quantity.");
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          items: clean.map((i) => ({
            productId: Number(i.productId),
            quantity: Number(i.quantity),
            unitPrice: Number(i.unitPrice),
            notes: i.notes,
          })),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to create order");
      setModal(false);
      setForm({ customerId: "", orderDate: new Date().toISOString().slice(0, 10), dueDate: "", notes: "" });
      setItems([blankItem()]);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Remove an order, with a written reason.
   *
   * The reason is not decoration: it is stored permanently beside the removal, in a record
   * that outlives the order. And the server's answer is shown verbatim rather than as
   * "Failed to delete", because the useful case is the refusal - it says which history is
   * in the way and where to go if this really is test data that has to be cleared.
   *
   * The old confirm() promised this would remove "its production, payments and delivery
   * records". It no longer can: an order with inspected production, a payment or a
   * delivery is refused here, and clearing one is the administrative cleanup's job.
   */
  async function del(id: number, num: string) {
    const reason = prompt(
      `Remove order ${num}?\n\nThis works only if the order has no inspected production, no customer payment and no delivery behind it. `
      + `Anything else is refused, so a real order's records cannot be destroyed from this list.\n\nReason (recorded permanently):`
    );
    if (reason === null) return;
    if (reason.trim().length < 10) {
      setErr("Give a reason of at least 10 characters. It is recorded permanently beside the removal.");
      return;
    }
    setErr("");
    const res = await fetch(`/api/orders/${id}?reason=${encodeURIComponent(reason.trim())}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(data.error || "Could not remove this order.");
      return;
    }
    load();
  }

  /**
   * The rows to draw are the page the server returned.
   *
   * There is deliberately no second filter here: re-filtering a server-filtered page in
   * the browser is how a list ends up showing fewer rows than the pager says exist, and
   * the search already ran where the data is.
   */
  const filtered = rows;

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Every uniform order Matesther has received - click an order to see production, costs and profit"
        action={
          <Btn onClick={() => { setErr(""); setModal(true); }}>
            <Plus className="w-4 h-4" /> New Order
          </Btn>
        }
      />
      {err && !modal && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</div>
      )}
      <Card className="mb-4 p-3 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order number or school…" className={`${inputCls} pl-9`} />
        </div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); setApplied((current) => ({ ...current, status: e.target.value })); }} className={`${inputCls} w-auto`}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="IN_PROGRESS">In Progress</option>
          <option value="COMPLETED">Completed</option>
          <option value="ON_HOLD">On Hold</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
      </Card>

      <Card>
        {loading ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={applied.search || applied.status ? "No orders match this search" : "No orders found"}
            hint={applied.search || applied.status ? "Clear the search or status filter to see every order." : "Create your first uniform order."}
          />
        ) : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[1050px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Order</th>
                  <th className="px-3 py-3">Customer</th>
                  <th className="px-3 py-3">Dates</th>
                  <th className="px-3 py-3 text-right">Qty</th>
                  <th className="px-3 py-3 text-right">Value</th>
                  <th className="px-3 py-3 text-right">Paid</th>
                  <th className="px-3 py-3 text-right">Balance</th>
                  <th className="px-3 py-3">Progress</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <Link href={`/orders/${o.id}`} className="font-bold text-matesther-800 hover:underline">
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-3">{o.customer}</td>
                    <td className="px-3 py-3 text-xs text-slate-500">
                      {fmtDate(o.orderDate)} → <span className="font-semibold text-slate-700">{fmtDate(o.dueDate)}</span>
                    </td>
                    <td className="px-3 py-3 text-right">{o.quantity.toLocaleString()}</td>
                    <td className="px-3 py-3 text-right font-semibold">{naira(o.totalAmount)}</td>
                    <td className="px-3 py-3 text-right text-matesther-700">{naira(o.amountPaid)}</td>
                    <td className="px-3 py-3 text-right font-semibold text-amber-700">{naira(o.balance)}</td>
                    <td className="px-3 py-3 min-w-[110px]">
                      <div className="flex items-center gap-2">
                        <ProgressBar pct={o.progress} />
                        <span className="text-[11px] text-slate-500">{o.progress}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-3"><Badge status={o.status} /></td>
                    <td className="px-3 py-3 text-right">
                      <button onClick={() => del(o.id, o.orderNumber)} className="p-1.5 text-slate-400 hover:text-red-700">
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

      {/* The pager reads the server's own total, so it says how many orders MATCH the
          current search rather than how many happen to be on this page. */}
      {!loading && total > PAGE_SIZE && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-slate-600">
            Showing {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total} orders
          </span>
          <div className="flex items-center gap-2">
            <Btn variant="ghost" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</Btn>
            <span className="px-2 py-1 text-slate-600">Page {page + 1} of {pageCount}</span>
            <Btn variant="ghost" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>Next</Btn>
          </div>
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="New Uniform Order" wide>
        <form onSubmit={save} className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Customer (school) *">
              <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} required className={inputCls}>
                <option value="">Select school…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Order date">
              <input type="date" value={form.orderDate} onChange={(e) => setForm({ ...form, orderDate: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Due date">
              <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className={inputCls} />
            </Field>
          </div>

          <div>
            <p className="text-xs font-medium text-slate-600 mb-2">Uniform products *</p>
            <div className="space-y-2">
              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-5">
                    <select value={it.productId} onChange={(e) => pickProduct(idx, e.target.value)} className={inputCls}>
                      <option value="">Select product…</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{p.name} - {naira(p.sellingPrice)}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <input type="number" min="1" placeholder="Qty" value={it.quantity} onChange={(e) => { const n = [...items]; n[idx].quantity = e.target.value; setItems(n); }} className={inputCls} />
                  </div>
                  <div className="col-span-3">
                    <input type="number" min="0" placeholder="Unit price ₦" value={it.unitPrice} onChange={(e) => { const n = [...items]; n[idx].unitPrice = e.target.value; setItems(n); }} className={inputCls} />
                  </div>
                  <div className="col-span-2 flex items-center gap-1">
                    <span className="text-xs font-semibold text-slate-700 flex-1">
                      {naira((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0))}
                    </span>
                    {items.length > 1 && (
                      <button type="button" onClick={() => setItems(items.filter((_, i) => i !== idx))} className="text-red-600 text-lg px-1">×</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setItems([...items, blankItem()])} className="mt-2 text-xs font-semibold text-matesther-700 hover:underline">
              + Add another product
            </button>
          </div>

          <Field label="Notes (sizes, monogram, special instructions)">
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputCls} rows={2} placeholder="e.g. JSS1 sets, monogram on chest pocket…" />
          </Field>

          <div className="flex items-center justify-between bg-matesther-50 border border-matesther-100 rounded-lg px-4 py-3">
            <span className="text-sm font-medium text-slate-600">Order value</span>
            <span className="text-lg font-bold text-matesther-800">{naira(estTotal)}</span>
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Creating…" : "Create Order"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
