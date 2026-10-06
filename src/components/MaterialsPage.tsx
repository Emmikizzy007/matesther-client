"use client";

import { useEffect, useState } from "react";
import { Plus, Search, AlertTriangle } from "lucide-react";
import { Card, CardHeader, PageHeader, Badge, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira, fmtDate } from "@/lib/format";

const CATS = ["Fabric", "Thread", "Elastic", "Buttons", "Notions", "Labels", "Packaging", "General"];

export default function MaterialsPage({
  initialTab = "stock",
}: {
  initialTab?: "stock" | "purchases" | "usage";
}) {
  const [mats, setMats] = useState<any[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [usage, setUsage] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(initialTab);
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const [matModal, setMatModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [matForm, setMatForm] = useState({ name: "", category: "Fabric", unit: "pcs", currentStock: "", reorderLevel: "", unitCost: "" });
  const [purModal, setPurModal] = useState(false);
  const [purForm, setPurForm] = useState({ materialId: "", supplier: "", quantity: "", unitCost: "", purchaseDate: new Date().toISOString().slice(0, 10), orderId: "", notes: "" });
  const [useModal, setUseModal] = useState(false);
  /**
   * What left the store, and what happened to all of it.
   *
   * `quantityIssued` is optional on purpose: leaving it blank means "issued equals used",
   * which is what every usage record made before this field existed means, so no
   * historical figure is restated by having somewhere to type it.
   */
  const [useForm, setUseForm] = useState({
    materialId: "", orderId: "", quantityIssued: "", quantityUsed: "",
    quantityReturned: "", quantityWasted: "", workerId: "", unitCost: "", notes: "",
  });
  const [people, setPeople] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([
      fetch("/api/materials", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/material-purchases", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/material-usage", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/orders", { cache: "no-store" }).then((r) => r.json()),
      // Slim list, for naming who took the material out of the store.
      fetch("/api/workers?view=slim", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
    ])
      .then(([m, p, u, o, w]) => {
        setMats(Array.isArray(m) ? m : []);
        setPurchases(Array.isArray(p) ? p : []);
        setUsage(Array.isArray(u) ? u : []);
        setOrders(Array.isArray(o) ? o : []);
        setPeople(Array.isArray(w) ? w : []);
      })
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function submit(url: string, body: any, method: string) {
    setSaving(true);
    setErr("");
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to save");
      return true;
    } catch (e: any) {
      setErr(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const filtered = mats.filter(
    (m) =>
      (!lowOnly || m.low) &&
      m.name.toLowerCase().includes(q.toLowerCase())
  );
  const totalStockValue = mats.reduce((s, m) => s + (m.stockValue ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Materials"
        subtitle={`Fabric, thread, elastic, buttons & supplies - total stock value ${naira(totalStockValue)}`}
        action={
          <>
            <Btn variant="secondary" onClick={() => { setErr(""); setUseForm({ materialId: "", orderId: "", quantityIssued: "", quantityUsed: "", quantityReturned: "", quantityWasted: "", workerId: "", unitCost: "", notes: "" }); setUseModal(true); }}>Record Usage</Btn>
            <Btn variant="secondary" onClick={() => { setErr(""); setPurForm({ materialId: "", supplier: "", quantity: "", unitCost: "", purchaseDate: new Date().toISOString().slice(0, 10), orderId: "", notes: "" }); setPurModal(true); }}>Record Purchase</Btn>
            <Btn onClick={() => { setEditing(null); setMatForm({ name: "", category: "Fabric", unit: "pcs", currentStock: "", reorderLevel: "", unitCost: "" }); setErr(""); setMatModal(true); }}>
              <Plus className="w-4 h-4" /> Add Material
            </Btn>
          </>
        }
      />

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {[{ k: "stock" as const, l: "Stock Levels" }, { k: "purchases" as const, l: `Purchases (${purchases.length})` }, { k: "usage" as const, l: `Usage (${usage.length})` }].map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)} className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px ${tab === t.k ? "border-matesther-700 text-matesther-800" : "border-transparent text-slate-500"}`}>
            {t.l}
          </button>
        ))}
      </div>

      {tab === "stock" && (
        <Card>
          <div className="p-3 flex flex-wrap gap-3 border-b border-slate-100">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search materials…" className={`${inputCls} pl-9`} />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="accent-red-700" />
              Low stock only
            </label>
          </div>
          {loading ? <Loading /> : filtered.length === 0 ? <EmptyState title="No materials" /> : (
            <div className="overflow-x-auto slim-scroll">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                    <th className="px-5 py-3">Material</th>
                    <th className="px-3 py-3">Category</th>
                    <th className="px-3 py-3 text-right">Stock</th>
                    <th className="px-3 py-3 text-right">Unit Cost</th>
                    <th className="px-3 py-3 text-right">Stock Value</th>
                    <th className="px-3 py-3 text-right">Purchased / Used</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filtered.map((m) => (
                    <tr key={m.id} className={`hover:bg-slate-50 ${m.low ? "bg-red-50/40" : ""}`}>
                      <td className="px-5 py-3 font-semibold">
                        {m.name}
                        <span className="block text-xs font-normal text-slate-500">per {m.unit} • reorder at {m.reorderLevel}</span>
                      </td>
                      <td className="px-3 py-3">{m.category}</td>
                      <td className="px-3 py-3 text-right font-bold">{m.currentStock} {m.unit}</td>
                      <td className="px-3 py-3 text-right">{naira(m.unitCost)}</td>
                      <td className="px-3 py-3 text-right font-semibold">{naira(m.stockValue)}</td>
                      <td className="px-3 py-3 text-right text-xs">{m.purchased} / {m.used}</td>
                      <td className="px-3 py-3">
                        {m.low ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-red-700 bg-red-100 border border-red-200 rounded-full px-2 py-0.5">
                            <AlertTriangle className="w-3 h-3" /> LOW STOCK
                          </span>
                        ) : (
                          <Badge status="COMPLETED" />
                        )}
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => {
                            setEditing(m);
                            setMatForm({ name: m.name, category: m.category, unit: m.unit, currentStock: String(m.currentStock), reorderLevel: String(m.reorderLevel), unitCost: String(m.unitCost) });
                            setErr("");
                            setMatModal(true);
                          }}
                          className="text-xs font-semibold text-matesther-700 hover:underline"
                        >
                          Adjust
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === "purchases" && (
        <Card>
          <CardHeader title="Material purchases" subtitle="Every purchase - optionally linked to the order it was bought for" />
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[820px]">
              <thead><tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100"><th className="px-5 py-3">Date</th><th className="px-3 py-3">Material</th><th className="px-3 py-3">Supplier</th><th className="px-3 py-3 text-right">Qty</th><th className="px-3 py-3 text-right">Total</th><th className="px-3 py-3">For Order</th></tr></thead>
              <tbody className="divide-y divide-slate-50">
                {purchases.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">{fmtDate(p.purchaseDate)}</td>
                    <td className="px-3 py-3 font-medium">{p.materialName}{p.notes && <span className="block text-xs text-slate-500 italic">{p.notes}</span>}</td>
                    <td className="px-3 py-3">{p.supplier || "-"}</td>
                    <td className="px-3 py-3 text-right">{p.quantity} {p.unit} × {naira(p.unitCost)}</td>
                    <td className="px-3 py-3 text-right font-bold">{naira(p.totalCost)}</td>
                    <td className="px-3 py-3">{p.orderNumber || <span className="text-slate-400">General stock</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {purchases.length === 0 && <EmptyState title="No purchases recorded" />}
          </div>
        </Card>
      )}

      {tab === "usage" && (
        <Card>
          <CardHeader
            title="Material usage"
            subtitle="What left the store, what happened to all of it, and what it cost the order - used and wasted are both charged, returned is not"
          />
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[1080px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-3 py-3">Material</th>
                  <th className="px-3 py-3">Order</th>
                  <th className="px-3 py-3 text-right">Issued</th>
                  <th className="px-3 py-3 text-right">Used</th>
                  <th className="px-3 py-3 text-right">Returned</th>
                  <th className="px-3 py-3 text-right">Wasted</th>
                  <th className="px-3 py-3 text-right">Cost</th>
                  <th className="px-3 py-3">Taken by</th>
                  <th className="px-3 py-3">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {usage.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 whitespace-nowrap">{fmtDate(u.usedAt)}</td>
                    <td className="px-3 py-3 font-medium">{u.materialName}</td>
                    <td className="px-3 py-3 text-xs">
                      {u.orderNumber ?? "—"}
                      {u.variant && <span className="block text-slate-500">{u.variant}</span>}
                    </td>
                    {/* A blank issued figure means issued equals used, which is what every
                        record made before the field existed means. Printed as the used
                        figure rather than as a dash, so the column still adds up. */}
                    <td className="px-3 py-3 text-right">{u.quantityIssued ?? u.quantityUsed} {u.unit}</td>
                    <td className="px-3 py-3 text-right">{u.quantityUsed} × {naira(u.unitCost)}</td>
                    <td className="px-3 py-3 text-right">{u.quantityReturned ? <span className="text-emerald-700">{u.quantityReturned}</span> : "-"}</td>
                    <td className="px-3 py-3 text-right">{u.quantityWasted ? <span className="text-red-700">{u.quantityWasted}</span> : "-"}</td>
                    <td className="px-3 py-3 text-right font-bold" title="Used plus wasted, at the unit cost. Returned material goes back into stock and is not charged to the order.">
                      {naira(u.totalCost)}
                      {(u.wastedCost ?? 0) > 0 && <span className="block text-[11px] font-normal text-red-600">incl. {naira(u.wastedCost)} wasted</span>}
                    </td>
                    <td className="px-3 py-3 text-xs">{u.workerName ?? "—"}</td>
                    <td className="px-3 py-3 text-xs text-slate-600 max-w-[220px]">{u.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {usage.length === 0 && <EmptyState title="No usage recorded" hint="Issue material against an order here and what is used, returned and wasted is charged to that order's cost." />}
          </div>
        </Card>
      )}

      {/* Add/Edit material */}
      <Modal open={matModal} onClose={() => setMatModal(false)} title={editing ? "Adjust Material" : "Add Material"}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const body = {
              id: editing?.id,
              name: matForm.name,
              category: matForm.category,
              unit: matForm.unit,
              currentStock: Number(matForm.currentStock) || 0,
              reorderLevel: Number(matForm.reorderLevel) || 0,
              unitCost: Number(matForm.unitCost) || 0,
            };
            const ok = await submit("/api/materials", body, editing ? "PUT" : "POST");
            if (ok) { setMatModal(false); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Material name *" className="sm:col-span-2"><input required value={matForm.name} onChange={(e) => setMatForm({ ...matForm, name: e.target.value })} className={inputCls} placeholder="e.g. Uniform Fabric - White Cotton" /></Field>
          <Field label="Category">
            <select value={matForm.category} onChange={(e) => setMatForm({ ...matForm, category: e.target.value })} className={inputCls}>
              {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Unit"><input value={matForm.unit} onChange={(e) => setMatForm({ ...matForm, unit: e.target.value })} className={inputCls} placeholder="yards, cones, packs…" /></Field>
          <Field label="Current stock"><input type="number" value={matForm.currentStock} onChange={(e) => setMatForm({ ...matForm, currentStock: e.target.value })} className={inputCls} /></Field>
          <Field label="Reorder level"><input type="number" value={matForm.reorderLevel} onChange={(e) => setMatForm({ ...matForm, reorderLevel: e.target.value })} className={inputCls} /></Field>
          <Field label="Unit cost (₦)" className="sm:col-span-2"><input type="number" value={matForm.unitCost} onChange={(e) => setMatForm({ ...matForm, unitCost: e.target.value })} className={inputCls} /></Field>
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setMatModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Purchase */}
      <Modal open={purModal} onClose={() => setPurModal(false)} title="Record Material Purchase">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await submit("/api/material-purchases", {
              materialId: Number(purForm.materialId),
              supplier: purForm.supplier,
              quantity: Number(purForm.quantity),
              unitCost: Number(purForm.unitCost),
              purchaseDate: purForm.purchaseDate,
              orderId: purForm.orderId || null,
              notes: purForm.notes,
            }, "POST");
            if (ok) { setPurModal(false); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Material *">
            <select required value={purForm.materialId} onChange={(e) => {
              const m = mats.find((x) => String(x.id) === e.target.value);
              setPurForm({ ...purForm, materialId: e.target.value, unitCost: m ? String(m.unitCost) : purForm.unitCost });
            }} className={inputCls}>
              <option value="">Select…</option>
              {mats.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
            </select>
          </Field>
          <Field label="Link to order (optional)">
            <select value={purForm.orderId} onChange={(e) => setPurForm({ ...purForm, orderId: e.target.value })} className={inputCls}>
              <option value="">General stock</option>
              {orders.map((o) => <option key={o.id} value={o.id}>{o.orderNumber} - {o.customer}</option>)}
            </select>
          </Field>
          <Field label="Supplier"><input value={purForm.supplier} onChange={(e) => setPurForm({ ...purForm, supplier: e.target.value })} className={inputCls} placeholder="e.g. Ariaria Fabric Depot" /></Field>
          <Field label="Purchase date"><input type="date" value={purForm.purchaseDate} onChange={(e) => setPurForm({ ...purForm, purchaseDate: e.target.value })} className={inputCls} /></Field>
          <Field label="Quantity *"><input type="number" min="1" required value={purForm.quantity} onChange={(e) => setPurForm({ ...purForm, quantity: e.target.value })} className={inputCls} /></Field>
          <Field label="Unit cost (₦) *"><input type="number" min="0" required value={purForm.unitCost} onChange={(e) => setPurForm({ ...purForm, unitCost: e.target.value })} className={inputCls} /></Field>
          <Field label="Notes" className="sm:col-span-2"><input value={purForm.notes} onChange={(e) => setPurForm({ ...purForm, notes: e.target.value })} className={inputCls} placeholder="e.g. Additional - fabric ran short during cutting" /></Field>
          {purForm.quantity && purForm.unitCost && (
            <p className="sm:col-span-2 text-sm font-bold">Total: {naira(Number(purForm.quantity) * Number(purForm.unitCost))}</p>
          )}
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setPurModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Purchase"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Usage */}
      <Modal open={useModal} onClose={() => setUseModal(false)} title="Record Material Usage">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await submit("/api/material-usage", {
              materialId: Number(useForm.materialId),
              orderId: Number(useForm.orderId),
              quantityIssued: useForm.quantityIssued === "" ? undefined : Number(useForm.quantityIssued),
              quantityUsed: Number(useForm.quantityUsed),
              quantityReturned: useForm.quantityReturned === "" ? 0 : Number(useForm.quantityReturned),
              quantityWasted: useForm.quantityWasted === "" ? 0 : Number(useForm.quantityWasted),
              workerId: useForm.workerId === "" ? undefined : Number(useForm.workerId),
              unitCost: useForm.unitCost === "" ? undefined : Number(useForm.unitCost),
              notes: useForm.notes.trim() || undefined,
            }, "POST");
            if (ok) { setUseModal(false); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Material *">
            <select required value={useForm.materialId} onChange={(e) => {
              const m = mats.find((x) => String(x.id) === e.target.value);
              setUseForm({ ...useForm, materialId: e.target.value, unitCost: m ? String(m.unitCost) : useForm.unitCost });
            }} className={inputCls}>
              <option value="">Select…</option>
              {mats.map((m) => <option key={m.id} value={m.id}>{m.name} - {m.currentStock} {m.unit} in stock</option>)}
            </select>
          </Field>
          <Field label="Charge to order *">
            <select required value={useForm.orderId} onChange={(e) => setUseForm({ ...useForm, orderId: e.target.value })} className={inputCls}>
              <option value="">Select…</option>
              {orders.filter((o) => o.status !== "CANCELLED").map((o) => <option key={o.id} value={o.id}>{o.orderNumber} - {o.customer}</option>)}
            </select>
          </Field>
          <Field label="Quantity issued"><input type="number" min="0" value={useForm.quantityIssued} onChange={(e) => setUseForm({ ...useForm, quantityIssued: e.target.value })} className={inputCls} placeholder="Blank = issued equals used" /></Field>
          <Field label="Quantity used *"><input type="number" min="1" required value={useForm.quantityUsed} onChange={(e) => setUseForm({ ...useForm, quantityUsed: e.target.value })} className={inputCls} /></Field>
          <Field label="Returned unused"><input type="number" min="0" value={useForm.quantityReturned} onChange={(e) => setUseForm({ ...useForm, quantityReturned: e.target.value })} className={inputCls} /></Field>
          <Field label="Wasted / written off"><input type="number" min="0" value={useForm.quantityWasted} onChange={(e) => setUseForm({ ...useForm, quantityWasted: e.target.value })} className={inputCls} /></Field>
          <Field label="Taken by">
            <select value={useForm.workerId} onChange={(e) => setUseForm({ ...useForm, workerId: e.target.value })} className={inputCls}>
              <option value="">Not recorded</option>
              {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </Field>
          <Field label="Unit cost (₦)"><input type="number" min="0" value={useForm.unitCost} onChange={(e) => setUseForm({ ...useForm, unitCost: e.target.value })} className={inputCls} /></Field>
          <Field label="Reason / notes" className="sm:col-span-2">
            <textarea rows={2} value={useForm.notes} onChange={(e) => setUseForm({ ...useForm, notes: e.target.value })} className={inputCls} placeholder="Required if anything was returned or written off, so the figure can be audited" />
          </Field>
          <p className="sm:col-span-2 rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">
            Used plus returned plus wasted can never exceed what was issued, and anything
            returned or written off needs a written reason. The order is charged for what was
            USED and what was WASTED; what came back goes into stock and is not charged.
            Leaving &ldquo;issued&rdquo; blank records it the way every older record reads -
            issued equals used - so no historical figure changes.
          </p>
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setUseModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Usage"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
