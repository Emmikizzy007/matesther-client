"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Plus,
  Pencil,
  User,
  Calendar,
  Package,
  Truck,
} from "lucide-react";
import {
  Card,
  CardHeader,
  Badge,
  ProgressBar,
  Loading,
  EmptyState,
  Modal,
  Field,
  inputCls,
  Btn,
} from "@/components/ui";
import { naira, fmtDate, stageLabel, EXPENSE_CATEGORIES, PAYMENT_METHODS, STAGES, personHoldsRole } from "@/lib/format";
import { useAuth } from "@/lib/auth";

const STAGE_ORDER = STAGES as readonly string[];

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuth();
  const [data, setData] = useState<any>(null);
  const [workers, setWorkers] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("production");
  const [err, setErr] = useState("");

  // modals
  const [opModal, setOpModal] = useState<any>(null);
  const [batchModal, setBatchModal] = useState(false);
  const [payModal, setPayModal] = useState(false);
  const [expModal, setExpModal] = useState(false);
  const [purModal, setPurModal] = useState(false);
  const [useModal, setUseModal] = useState(false);
  const [editModal, setEditModal] = useState(false);
  const [qcModal, setQcModal] = useState<any>(null);
  const [rwModal, setRwModal] = useState<any>(null);
  const [inspModal, setInspModal] = useState<any>(null);
  const [inspForm, setInspForm] = useState({ quantityApproved: "", quantityRework: "", quantityRejected: "", notes: "" });
  const [inspections, setInspections] = useState<any[]>([]);
  const [submitVal, setSubmitVal] = useState("");
  const [sizesData, setSizesData] = useState<Record<number, any[]>>({});
  const [sizesItem, setSizesItem] = useState<any>(null);
  const [sizeRows, setSizeRows] = useState<any[]>([]);
  const [packModal, setPackModal] = useState(false);
  const [delModal, setDelModal] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [saving, setSaving] = useState(false);

  const emptyBatchForm = () => ({ quantity: "", orderItemId: "", size: "", color: "", workerId: "", cuttingRate: "", tailorId: "", sewingRate: "", expectedCompletionDate: "" });
  const [batchForm, setBatchForm] = useState(emptyBatchForm);
  const [payForm, setPayForm] = useState({ amount: "", paymentDate: new Date().toISOString().slice(0, 10), paymentMethod: "Bank Transfer", reference: "", notes: "" });
  const [expForm, setExpForm] = useState({ category: "Labour", description: "", amount: "", expenseDate: new Date().toISOString().slice(0, 10), notes: "" });
  const [purForm, setPurForm] = useState({ materialId: "", supplier: "", quantity: "", unitCost: "", purchaseDate: new Date().toISOString().slice(0, 10), notes: "" });
  const [useForm, setUseForm] = useState({ materialId: "", productionOperationId: "", quantityUsed: "", unitCost: "" });
  const [editForm, setEditForm] = useState<any>({});
  const [editItems, setEditItems] = useState<any[]>([]);
  const [qcForm, setQcForm] = useState({ quantityChecked: "", quantityPassed: "", notes: "" });
  const [rwForm, setRwForm] = useState({ quantity: "", reason: "", status: "PENDING" });
  const [packForm, setPackForm] = useState({ quantityPacked: "", packageCount: "", notes: "" });
  const [delForm, setDelForm] = useState({ deliveryDate: new Date().toISOString().slice(0, 10), deliveredQuantity: "", recipient: "", deliveryAddress: "", status: "DELIVERED", notes: "" });
  const [deliveryLines, setDeliveryLines] = useState<{ orderItemId: string; size: string; quantity: string }[]>([]);
  const [lastDeliveryId, setLastDeliveryId] = useState<number | null>(null);

  function load() {
    setLoading(true);
    Promise.all([
      fetch(`/api/orders/${id}`, { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/workers?view=slim", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/materials", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/products", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/customers", { cache: "no-store" }).then((r) => r.json()),
      fetch(`/api/inspections?orderId=${id}`, { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(async ([d, w, m, p, c, insp]) => {
        if (d.error) setErr(d.error);
        else {
          setData(d);
          setEditForm({ customerId: d.order.customerId, orderDate: d.order.orderDate, dueDate: d.order.dueDate || "", status: d.order.status, notes: d.order.notes || "" });
          setEditItems(d.items.map((i: any) => ({ productId: String(i.productId), quantity: String(i.quantity), unitPrice: String(i.unitPrice), notes: i.notes || "" })));
        }
        setWorkers(Array.isArray(w) ? w : []);
        setMaterials(Array.isArray(m) ? m : []);
        setProducts(Array.isArray(p) ? p : []);
        setCustomers(Array.isArray(c) ? c : []);
        setInspections(Array.isArray(insp) ? insp : []);
        const sd: Record<number, any[]> = {};
        await Promise.all(
          d.items.map((it: any) =>
            fetch(`/api/order-sizes?itemId=${it.id}`, { cache: "no-store" })
              .then((r) => r.json())
              .then((res) => {
                if (Array.isArray(res.sizes)) sd[it.id] = res.sizes;
              })
              .catch(() => {})
          )
        );
        setSizesData(sd);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }

  async function openSizes(it: any) {
    setSizesItem(it);
    try {
      const res = await fetch(`/api/order-sizes?itemId=${it.id}`, { cache: "no-store" }).then((r) => r.json());
      setSizeRows(
        res.sizes && res.sizes.length
          ? res.sizes.map((s: any) => ({ size: s.size, quantity: String(s.quantity), completed: String(s.completed) }))
          : ["S", "M", "L", "XL"].map((s) => ({ size: s, quantity: "", completed: "0" }))
      );
    } catch {
      setSizeRows(["S", "M", "L", "XL"].map((s) => ({ size: s, quantity: "", completed: "0" })));
    }
  }

  async function saveSizes(e: React.FormEvent) {
    e.preventDefault();
    const clean = sizeRows.filter((r) => r.size && Number(r.quantity) > 0);
    const res = await fetch("/api/order-sizes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: sizesItem.id, sizes: clean }),
    });
    if (res.ok) {
      setSizesItem(null);
      load();
    }
  }
  useEffect(load, [id]);

  async function post(url: string, body: any, method = "POST") {
    setSaving(true);
    setFormErr("");
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to save");
      return d;
    } catch (e: any) {
      setFormErr(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Loading label="Loading order…" />;
  if (err || !data) return <p className="text-sm text-red-700">Failed to load order: {err}</p>;

  const { order, items, batches, usage, purchases, expenses, payments, packing, deliveries, quality, rework, costs, progress, totalQuantity, packedQuantity, deliveredQuantity } = data;
  const expectedSpecialty: Record<string, string> = { CUTTING: "Cutter", SEWING: "Tailor", MONOGRAMMING: "Monogrammer", BUTTONHOLE: "Buttonhole", BUTTON_TACKING: "Button Tacking", IRONING: "Ironer", PACKING: "Packer", DELIVERY: "Packer" };
  const marginColor = costs.margin >= 20 ? "text-emerald-700" : costs.margin >= 0 ? "text-amber-700" : "text-red-700";

  const tabs = [
    { k: "production", label: "Production Timeline" },
    { k: "sizes", label: "Sizes" },
    { k: "materials", label: `Materials (${purchases.length + usage.length})` },
    { k: "expenses", label: `Expenses (${expenses.length})` },
    { k: "payments", label: `Payments (${payments.length})` },
    { k: "quality", label: "Quality & Rework" },
    { k: "delivery", label: "Packing & Delivery" },
  ];

  return (
    <div>
      <Link href="/orders" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-matesther-800 mb-3">
        <ArrowLeft className="w-4 h-4" /> Back to orders
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold">{order.orderNumber}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {order.customer?.name} • {order.customer?.type} • Ordered {fmtDate(order.orderDate)} • Due {fmtDate(order.dueDate)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Badge status={order.status} />
          <Btn variant="secondary" onClick={() => { setFormErr(""); setEditModal(true); }}><Pencil className="w-4 h-4" /> Edit</Btn>
          <Btn variant="gold" onClick={() => { setFormErr(""); setBatchModal(true); }}><Plus className="w-4 h-4" /> Start Production</Btn>
        </div>
      </div>

      {order.notes && (
        <Card className="p-4 mb-4 text-sm text-slate-600">
          <span className="font-semibold text-slate-800">Order notes: </span>{order.notes}
        </Card>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 mb-4">
        {[
          ["Order value", naira(costs.revenue)],
          ["Paid", naira(order.amountPaid)],
          ["Balance owed", naira(order.balance)],
          ["Total cost", naira(costs.totalCost)],
          ["Est. profit", naira(costs.profit)],
          ["Margin", `${costs.margin}%`],
          ["Garments", totalQuantity.toLocaleString()],
          ["Progress", `${progress}%`],
        ].map(([l, v]) => (
          <Card key={l} className="p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{l}</p>
            <p className={`text-base font-bold truncate ${l === "Margin" ? marginColor : ""}`}>{v}</p>
          </Card>
        ))}
      </div>

      {/* Profitability panel */}
      <Card className="mb-4">
        <CardHeader title="Revenue → Costs → Profit" subtitle="Updates automatically as materials, labour and expenses are recorded" />
        <div className="p-5 grid lg:grid-cols-3 gap-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Cost breakdown</p>
            <div className="space-y-1.5 text-sm">
              {costs.usageByCategory.map((c: any) => (
                <div key={c.category} className="flex justify-between">
                  <span className="text-slate-600">{c.category} (materials used)</span>
                  <span className="font-semibold">{naira(c.amount)}</span>
                </div>
              ))}
              {costs.expensesByCategory.map((c: any) => (
                <div key={c.category} className="flex justify-between">
                  <span className="text-slate-600">{c.category}</span>
                  <span className="font-semibold">{naira(c.amount)}</span>
                </div>
              ))}
              {costs.usageByCategory.length + costs.expensesByCategory.length === 0 && (
                <p className="text-slate-400">No costs recorded yet.</p>
              )}
            </div>
            <div className="flex justify-between border-t border-slate-200 mt-3 pt-2 text-sm font-bold">
              <span>TOTAL COST</span>
              <span>{naira(costs.totalCost)}</span>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Products in this order</p>
            <div className="space-y-1.5 text-sm">
              {items.map((i: any) => (
                <div key={i.id} className="flex justify-between">
                  <span className="text-slate-600">{i.productName} × {i.quantity}</span>
                  <span className="font-semibold">{naira(i.totalPrice)}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between border-t border-slate-200 mt-3 pt-2 text-sm font-bold">
              <span>REVENUE</span>
              <span>{naira(costs.revenue)}</span>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Material purchases linked to this order: <span className="font-semibold">{naira(costs.purchaseTotal)}</span> (stock bought for this job)
            </p>
          </div>
          <div className="bg-matesther-950 text-white rounded-xl p-5 flex flex-col justify-center">
            <p className="text-xs uppercase tracking-wide text-matesther-100/70">Estimated profit</p>
            <p className={`text-3xl font-extrabold mt-1 ${costs.profit >= 0 ? "text-gold-400" : "text-red-400"}`}>{naira(costs.profit)}</p>
            <p className="text-sm mt-1">Margin: <span className="font-bold">{costs.margin}%</span></p>
            <div className="mt-3 h-2 bg-white/15 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${costs.margin >= 0 ? "bg-gold-400" : "bg-red-400"}`} style={{ width: `${Math.min(100, Math.max(0, costs.margin))}%` }} />
            </div>
            <p className="text-[11px] text-matesther-100/60 mt-3">
              Revenue {naira(costs.revenue)} − Costs {naira(costs.totalCost)} = Profit {naira(costs.profit)}
            </p>
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto slim-scroll border-b border-slate-200 mb-4">
        {tabs.map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
              tab === t.k ? "border-matesther-700 text-matesther-800" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* PRODUCTION */}
      {tab === "production" && (
        <div className="space-y-4">
          {batches.length === 0 && (
            <Card><EmptyState title="Production has not started" hint="Start Production creates all eight stages for a garment, size and colour batch." /></Card>
          )}
          {batches.map((b: any) => (
            <Card key={b.id}>
              <CardHeader
                title={`${b.batchNumber} - ${b.quantity} garments`}
                subtitle={[b.itemName, b.size && `Size ${b.size}`, b.color && `Colour ${b.color}`].filter(Boolean).join(" • ")}
                action={
                  <div className="flex items-center gap-2">
                    <Badge status={b.status} />
                    <span className="text-xs text-slate-500">{b.progress}%</span>
                    {user?.role === "OWNER" &&
                      !b.operations.some((o: any) => (o.quantityApproved ?? 0) > 0) && (
                        <button
                          onClick={async () => {
                            if (!confirm(`Remove batch ${b.batchNumber}? No work has been approved on it, so its stages will be deleted.`)) return;
                            const res = await fetch(`/api/batches?id=${b.id}`, { method: "DELETE" });
                            const dd = await res.json();
                            if (!res.ok) alert(dd.error);
                            else load();
                          }}
                          className="text-xs font-semibold text-red-600 hover:underline"
                        >
                          Remove batch
                        </button>
                      )}
                  </div>
                }
              />
              <div className="p-4">
                <ProgressBar pct={b.progress} className="mb-4" />
                {/* timeline */}
                <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {STAGE_ORDER.map((st, si) => {
                    const op = b.operations.find((o: any) => o.stage === st);
                    if (!op) return null;
                    return (
                      <div key={st} className={`rounded-lg border p-3 ${op.status === "COMPLETED" ? "border-emerald-200 bg-emerald-50/50" : op.status === "IN_PROGRESS" ? "border-blue-200 bg-blue-50/50" : "border-slate-200"}`}>
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-bold uppercase tracking-wide text-matesther-800">
                            {si + 1}. {stageLabel(st)}
                          </p>
                          <Badge status={op.status} />
                        </div>
                        <p className="text-[13px] mt-1.5 flex items-center gap-1.5">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          <span className="font-medium">{op.workerName || <span className="text-slate-400">Unassigned</span>}</span>
                        </p>
                        {op.workerName && <p className="mt-1 text-[11px] font-semibold text-matesther-700">{op.pieceRate !== null ? `${naira(op.pieceRate)} per approved garment` : "Salary / historical rate"}{b.size ? ` • Size ${b.size}` : ""}{b.color ? ` • ${b.color}` : ""}</p>}
                        <div className="grid grid-cols-6 gap-1 mt-2 text-center">
                          {[["Rcvd", op.quantityReceived], ["Subm", op.quantityCompleted], ["Appr", op.quantityApproved], ["Rework", op.quantityRework], ["Rej", op.quantityRejected], ["Left", op.quantityRemaining]].map(([l, v]: any) => (
                            <div key={l} className="bg-white rounded border border-slate-100 py-1">
                              <p className="text-[10px] text-slate-400">{l}</p>
                              <p className="text-[13px] font-bold">{v}</p>
                            </div>
                          ))}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-2 flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {op.expectedCompletionDate ? `Expected ${fmtDate(op.expectedCompletionDate)}` : "No target date"}
                          {op.completedAt ? ` • Done ${fmtDate(op.completedAt)}` : ""}
                          {op.inspector ? ` • Inspected by ${op.inspector}` : ""}
                        </p>
                        {op.notes && <p className="text-[11px] text-slate-500 mt-1 italic truncate">{op.notes}</p>}
                        {inspections.filter((i) => i.productionOperationId === op.id).slice(0, 2).map((i) => (
                          <p key={i.id} className="text-[11px] text-slate-500 mt-1">
                            <span className="text-emerald-700 font-semibold">{i.quantityApproved} approved</span>
                            {i.quantityRework > 0 && <span className="text-amber-700"> • {i.quantityRework} rework</span>}
                            {i.quantityRejected > 0 && <span className="text-red-600"> • {i.quantityRejected} rejected</span>}
                            {" "} - {i.inspectedBy}, {fmtDate(i.inspectedAt)}
                          </p>
                        ))}
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          <button onClick={() => { setFormErr(""); setOpModal({ ...op }); }} className="text-[11px] font-semibold text-matesther-700 hover:underline">Update</button>
                          {op.pendingInspection > 0 && user?.role === "OWNER" && (
                            <>
                              <span className="text-slate-300">|</span>
                              <button
                                onClick={() => { setInspForm({ quantityApproved: String(op.pendingInspection), quantityRework: "0", quantityRejected: "0", notes: "" }); setFormErr(""); setInspModal(op); }}
                                className="text-[11px] font-bold text-violet-700 hover:underline"
                              >
                                Inspect ({op.pendingInspection})
                              </button>
                            </>
                          )}
                          <span className="text-slate-300">|</span>
                          <button onClick={() => { setQcForm({ quantityChecked: "", quantityPassed: "", notes: "" }); setFormErr(""); setQcModal(op); }} className="text-[11px] font-semibold text-matesther-700 hover:underline">QC check</button>
                          <span className="text-slate-300">|</span>
                          <button onClick={() => { setRwForm({ quantity: "", reason: "", status: "PENDING" }); setFormErr(""); setRwModal(op); }} className="text-[11px] font-semibold text-amber-700 hover:underline">Rework</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* MATERIALS */}
      {tab === "materials" && (
        <div className="grid xl:grid-cols-2 gap-4">
          <Card>
            <CardHeader title="Purchases linked to this order" subtitle="Includes top-up purchases when fabric ran short" action={<Btn variant="secondary" onClick={() => { setFormErr(""); setPurForm({ materialId: "", supplier: "", quantity: "", unitCost: "", purchaseDate: new Date().toISOString().slice(0, 10), notes: "" }); setPurModal(true); }}><Plus className="w-3.5 h-3.5" /> Purchase</Btn>} />
            <div className="divide-y divide-slate-100">
              {purchases.map((p: any) => (
                <div key={p.id} className="px-5 py-3 text-sm">
                  <div className="flex justify-between"><span className="font-semibold">{p.materialName}</span><span className="font-bold">{naira(p.totalCost)}</span></div>
                  <p className="text-xs text-slate-500">{p.quantity} {p.unit} × {naira(p.unitCost)} • {p.supplier || "-"} • {fmtDate(p.purchaseDate)}</p>
                  {p.notes && <p className="text-xs text-slate-500 italic">{p.notes}</p>}
                </div>
              ))}
              {purchases.length === 0 && <p className="p-5 text-sm text-slate-500">No linked purchases.</p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Materials actually used" subtitle="Counted against this order's cost" action={<Btn variant="secondary" onClick={() => { setFormErr(""); setUseForm({ materialId: "", productionOperationId: "", quantityUsed: "", unitCost: "" }); setUseModal(true); }}><Plus className="w-3.5 h-3.5" /> Record usage</Btn>} />
            <div className="divide-y divide-slate-100">
              {usage.map((u: any) => (
                <div key={u.id} className="px-5 py-3 text-sm">
                  <div className="flex justify-between"><span className="font-semibold">{u.materialName}</span><span className="font-bold">{naira(u.totalCost)}</span></div>
                  <p className="text-xs text-slate-500">{u.quantityUsed} {u.unit} × {naira(u.unitCost)} • {fmtDate(u.usedAt)}</p>
                </div>
              ))}
              {usage.length === 0 && <p className="p-5 text-sm text-slate-500">No usage recorded.</p>}
            </div>
          </Card>
        </div>
      )}

      {/* EXPENSES */}
      {tab === "expenses" && (
        <Card>
          <CardHeader title={`Order expenses - ${naira(costs.expenseCost)}`} action={<Btn onClick={() => { setFormErr(""); setExpForm({ category: "Labour", description: "", amount: "", expenseDate: new Date().toISOString().slice(0, 10), notes: "" }); setExpModal(true); }}><Plus className="w-4 h-4" /> Add Expense</Btn>} />
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[640px]">
              <thead><tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100"><th className="px-5 py-3">Description</th><th className="px-3 py-3">Category</th><th className="px-3 py-3">Date</th><th className="px-3 py-3 text-right">Amount</th></tr></thead>
              <tbody className="divide-y divide-slate-50">
                {expenses.map((e: any) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium">{e.description}{e.notes && <span className="text-xs text-slate-500 block">{e.notes}</span>}</td>
                    <td className="px-3 py-3"><Badge status={e.category === "Labour" ? "IN_PROGRESS" : "PENDING"} /> <span className="text-xs">{e.category}</span></td>
                    <td className="px-3 py-3">{fmtDate(e.expenseDate)}</td>
                    <td className="px-3 py-3 text-right font-bold">{naira(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {expenses.length === 0 && <EmptyState title="No expenses on this order" />}
          </div>
        </Card>
      )}

      {/* PAYMENTS */}
      {tab === "payments" && (
        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Payment summary</p>
            <p className="text-2xl font-bold mt-1">{naira(order.amountPaid)} <span className="text-sm font-normal text-slate-500">of {naira(costs.revenue)}</span></p>
            <ProgressBar pct={costs.revenue ? (order.amountPaid / costs.revenue) * 100 : 0} className="my-3" />
            <p className="text-sm">Balance owed: <span className="font-bold text-amber-700">{naira(order.balance)}</span></p>
            <Btn className="mt-4 w-full" onClick={() => { setFormErr(""); setPayForm({ amount: order.balance > 0 ? String(order.balance) : "", paymentDate: new Date().toISOString().slice(0, 10), paymentMethod: "Bank Transfer", reference: "", notes: "" }); setPayModal(true); }}>
              <Plus className="w-4 h-4" /> Record Payment
            </Btn>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader title="Payments received" />
            <div className="divide-y divide-slate-100">
              {payments.map((p: any) => (
                <div key={p.id} className="px-5 py-3 text-sm flex justify-between items-center">
                  <div>
                    <p className="font-semibold">{naira(p.amount)} <span className="font-normal text-slate-500">• {p.paymentMethod}</span></p>
                    <p className="text-xs text-slate-500">{fmtDate(p.paymentDate)}{p.reference ? ` • ${p.reference}` : ""}{p.notes ? ` • ${p.notes}` : ""}</p>
                <a href={`/receipt/${p.id}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-matesther-700 hover:underline">
                  Open receipt MTH-REC-{String(p.id).padStart(4, "0")} ↗
                </a>
                  </div>
                  <button
                    onClick={async () => {
                      if (!confirm("Delete this payment?")) return;
                      await fetch(`/api/payments?id=${p.id}`, { method: "DELETE" });
                      load();
                    }}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              ))}
              {payments.length === 0 && <p className="p-5 text-sm text-slate-500">No payments yet.</p>}
            </div>
          </Card>
        </div>
      )}

      {/* QUALITY */}
      {tab === "quality" && (
        <div className="grid xl:grid-cols-2 gap-4">
          <Card>
            <CardHeader title="Quality checks" subtitle="Inspections recorded at each stage" />
            <div className="divide-y divide-slate-100">
              {quality.map((q: any) => (
                <div key={q.id} className="px-5 py-3 text-sm">
                  <p className="font-semibold">{stageLabel(q.stage)} - checked {q.quantityChecked}, passed {q.quantityPassed}, <span className="text-red-600">failed {q.quantityFailed}</span></p>
                  <p className="text-xs text-slate-500">{fmtDate(q.checkedAt)}{q.notes ? ` • ${q.notes}` : ""}</p>
                </div>
              ))}
              {quality.length === 0 && <p className="p-5 text-sm text-slate-500">No quality checks recorded. Use “QC check” on any stage.</p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Rework records" subtitle="Garments sent back for correction" />
            <div className="divide-y divide-slate-100">
              {rework.map((r: any) => (
                <div key={r.id} className="px-5 py-3 text-sm flex justify-between items-center">
                  <div>
                    <p className="font-semibold">{stageLabel(r.stage)} - {r.quantity} pcs</p>
                    <p className="text-xs text-slate-500">{r.reason || "-"} • {fmtDate(r.createdAt)}</p>
                  </div>
                  <Badge status={r.status === "FIXED" ? "COMPLETED" : "IN_PROGRESS"} />
                </div>
              ))}
              {rework.length === 0 && <p className="p-5 text-sm text-slate-500">No rework recorded.</p>}
            </div>
          </Card>
        </div>
      )}

      {/* SIZES */}
      {tab === "sizes" && (
        <div className="space-y-4">
          {items.map((it: any) => {
            const sz = sizesData[it.id] ?? [];
            const totalOrdered = sz.reduce((s: number, r: any) => s + (r.quantity ?? 0), 0);
            const totalDone = sz.reduce((s: number, r: any) => s + (r.completed ?? 0), 0);
            const outstanding = sz.filter((r: any) => (r.completed ?? 0) < (r.quantity ?? 0));
            return (
              <Card key={it.id}>
                <CardHeader
                  title={`${it.productName} - ${it.quantity} pcs ordered`}
                  subtitle={
                    sz.length
                      ? `${totalDone}/${totalOrdered} finished • ${outstanding.length ? "Outstanding: " + outstanding.map((r: any) => `${r.size} (${r.quantity - r.completed} left)`).join(", ") : "All sizes finished ✓"}`
                      : "No size breakdown set yet - set it to track which sizes are finished"
                  }
                  action={<Btn variant="secondary" onClick={() => openSizes(it)}>{sz.length ? "Edit sizes" : "Set sizes"}</Btn>}
                />
                {sz.length > 0 && (
                  <div className="p-5 flex flex-wrap gap-2">
                    {sz.map((r: any) => {
                      const done = (r.completed ?? 0) >= (r.quantity ?? 0);
                      return (
                        <div key={r.id} className={`rounded-lg border px-4 py-2.5 text-center min-w-[88px] ${done ? "border-emerald-300 bg-emerald-50" : "border-amber-200 bg-amber-50/40"}`}>
                          <p className="text-[11px] font-bold text-slate-500">{r.size}</p>
                          <p className="text-lg font-extrabold text-slate-900">{r.completed}<span className="text-xs font-semibold text-slate-400">/{r.quantity}</span></p>
                          <p className={`text-[10px] font-bold ${done ? "text-emerald-700" : "text-amber-700"}`}>{done ? "FINISHED" : `${r.quantity - r.completed} LEFT`}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
          <p className="text-xs text-slate-500">
            Hand sizes to tailors as pieces are cut - update each size's finished count here, and the
            “Outstanding” line always shows what is still on the floor.
          </p>
        </div>
      )}

      {/* DELIVERY */}
      {tab === "delivery" && (
        <div>
          {lastDeliveryId && (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              Delivery saved. <a className="font-bold underline" href={`/delivery/${lastDeliveryId}`} target="_blank" rel="noreferrer">Open the letterheaded delivery sheet</a> to print or save as PDF.
            </div>
          )}
          <div className="grid xl:grid-cols-2 gap-4">
          <Card>
            <CardHeader
              title={`Packing - ${packedQuantity} packed`}
              action={<Btn variant="secondary" onClick={() => { setFormErr(""); setPackForm({ quantityPacked: "", packageCount: "", notes: "" }); setPackModal(true); }}><Package className="w-4 h-4" /> Record packing</Btn>}
            />
            <div className="divide-y divide-slate-100">
              {packing.map((p: any) => (
                <div key={p.id} className="px-5 py-3 text-sm">
                  <p className="font-semibold">{p.quantityPacked} garments in {p.packageCount} packages</p>
                  <p className="text-xs text-slate-500">{fmtDate(p.packedAt)}{p.notes ? ` • ${p.notes}` : ""}</p>
                </div>
              ))}
              {packing.length === 0 && <p className="p-5 text-sm text-slate-500">Nothing packed yet.</p>}
            </div>
          </Card>
          <Card>
            <CardHeader
              title={`Deliveries - ${deliveredQuantity} delivered`}
              action={<Btn variant="secondary" onClick={() => { setFormErr(""); setDelForm({ deliveryDate: new Date().toISOString().slice(0, 10), deliveredQuantity: "", recipient: order.customer?.contactPerson || "", deliveryAddress: order.customer?.address || "", status: "DELIVERED", notes: "" }); setDeliveryLines([{ orderItemId: items[0] ? String(items[0].id) : "", size: "", quantity: "" }]); setDelModal(true); }}><Truck className="w-4 h-4" /> Record delivery</Btn>}
            />
            <div className="divide-y divide-slate-100">
              {deliveries.map((x: any) => (
                <div key={x.id} className="px-5 py-3 text-sm">
                  <div className="flex justify-between items-center">
                    <p className="font-semibold">{x.deliveredQuantity} garments - {fmtDate(x.deliveryDate)}</p>
                    <Badge status={x.status} />
                  </div>
                  <p className="text-xs text-slate-500">To: {x.recipient || "Not recorded"} • {x.deliveryAddress || "Not recorded"}{x.notes ? ` • ${x.notes}` : ""}</p>
                  <a href={`/delivery/${x.id}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-bold text-matesther-700 hover:underline">Print / share delivery sheet MTH-DLV-{String(x.id).padStart(4, "0")}</a>
                </div>
              ))}
              {deliveries.length === 0 && <p className="p-5 text-sm text-slate-500">Not delivered yet.</p>}
            </div>
          </Card>
          </div>
        </div>
      )}

      {/* ---- MODALS ---- */}

      {/* Update operation */}
      <Modal open={!!opModal} onClose={() => setOpModal(null)} title={opModal ? `Update - ${stageLabel(opModal.stage)} (${opModal.batchNumber || ""})` : ""}>
        {opModal && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              // Only the fields this modal may change. It used to post the whole
              // job object back, quantities included. Quantities are derived from
              // what was allocated, submitted and inspected, so they are no longer
              // editable here at all - the server refuses them.
              const body: any = {
                id: opModal.id,
                workerId: opModal.workerId ?? null,
                pieceRate: opModal.pieceRate,
                expectedCompletionDate: opModal.expectedCompletionDate || null,
                notes: opModal.notes ?? "",
              };
              if (submitVal && Number(submitVal) > 0) {
                // A submission is an event of its own, and cannot carry an edit.
                body.submitQty = Number(submitVal);
              } else {
                body.status = opModal.status;
              }
              const r = await post("/api/operations", body, "PUT");
              if (r) { setOpModal(null); setSubmitVal(""); load(); }
            }}
            className="grid sm:grid-cols-2 gap-3"
          >
            <Field label="Assigned worker">
              <select value={opModal.workerId || ""} onChange={(e) => setOpModal({ ...opModal, workerId: e.target.value ? Number(e.target.value) : null, pieceRate: null })} className={inputCls}>
                <option value="">Unassigned</option>
                {workers.filter((w) => w.status === "ACTIVE" && (!expectedSpecialty[opModal.stage] || personHoldsRole(w, expectedSpecialty[opModal.stage]))).map((w) => <option key={w.id} value={w.id}>{w.name} - {expectedSpecialty[opModal.stage] ?? w.specialty}</option>)}
              </select>
            </Field>
            {workers.find((w) => w.id === Number(opModal.workerId))?.paymentType === "PER_PIECE" && <Field label="Agreed pay per approved garment (₦) *">
              <input type="number" min="1" step="1" required={opModal.quantityCompleted === 0 && opModal.pieceRate === null} disabled={opModal.quantityCompleted > 0 || opModal.quantityInspected > 0}
                value={opModal.pieceRate ?? ""} onChange={(e) => setOpModal({ ...opModal, pieceRate: e.target.value === "" ? null : Number(e.target.value) })} className={inputCls} />
            </Field>}
            <Field label="Status">
              <select value={opModal.status} onChange={(e) => setOpModal({ ...opModal, status: e.target.value })} className={inputCls}>
                <option value="PENDING">Pending</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="SUBMITTED">Submitted for inspection</option>
                <option value="COMPLETED">Completed (requires approved inspection)</option>
                <option value="ON_HOLD">On Hold</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </Field>
            <Field label="Submit more pieces for inspection (optional)">
              <input type="number" min="0" value={submitVal} onChange={(e) => setSubmitVal(e.target.value)} placeholder="e.g. 25" className={inputCls} />
            </Field>
            {/* Derived quantities: shown, never typed. */}
            <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-2">Quantities - derived from the production trail</p>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span className="bg-white border border-slate-200 rounded px-2 py-0.5">Received <strong>{opModal.quantityReceived ?? 0}</strong></span>
                <span className="bg-white border border-slate-200 rounded px-2 py-0.5">Submitted <strong>{opModal.quantityCompleted ?? 0}</strong></span>
                <span className="bg-white border border-emerald-200 rounded px-2 py-0.5">Approved <strong className="text-emerald-700">{opModal.quantityApproved ?? 0}</strong></span>
                <span className="bg-white border border-slate-200 rounded px-2 py-0.5">Rework <strong>{opModal.quantityRework ?? 0}</strong></span>
                <span className="bg-white border border-red-200 rounded px-2 py-0.5">Rejected <strong className="text-red-700">{opModal.quantityRejected ?? 0}</strong></span>
                <span className="bg-white border border-slate-200 rounded px-2 py-0.5">Outstanding <strong>{opModal.quantityRemaining ?? 0}</strong></span>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                A stage receives only what the previous stage approved. To fix a genuine mis-count the Owner records an
                audited correction, which keeps who changed it, when and why.
              </p>
            </div>
            <Field label="Expected completion"><input type="date" value={opModal.expectedCompletionDate || ""} onChange={(e) => setOpModal({ ...opModal, expectedCompletionDate: e.target.value })} className={inputCls} /></Field>
            <Field label="Notes" className="sm:col-span-2">
              <textarea value={opModal.notes || ""} onChange={(e) => setOpModal({ ...opModal, notes: e.target.value })} className={inputCls} rows={2} />
            </Field>
            {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
            <div className="sm:col-span-2 flex justify-end gap-2">
              <Btn variant="secondary" onClick={() => setOpModal(null)}>Cancel</Btn>
              <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Update"}</Btn>
            </div>
          </form>
        )}
      </Modal>

      {/* Start production - agree rates for this garment, size and colour */}
      <Modal open={batchModal} onClose={() => setBatchModal(false)} title="Start Production - assign a batch" wide>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post("/api/batches", {
              orderId: Number(id), quantity: Number(batchForm.quantity), orderItemId: Number(batchForm.orderItemId),
              size: batchForm.size, color: batchForm.color, workerId: batchForm.workerId || null,
              cuttingRate: batchForm.cuttingRate === "" ? null : Number(batchForm.cuttingRate),
              tailorId: batchForm.tailorId || null, sewingRate: batchForm.sewingRate === "" ? null : Number(batchForm.sewingRate),
              expectedCompletionDate: batchForm.expectedCompletionDate || null,
            });
            if (r) { setBatchModal(false); setBatchForm(emptyBatchForm()); setTab("production"); load(); }
          }}
          className="grid gap-4 sm:grid-cols-2"
        >
          <p className="sm:col-span-2 rounded-lg bg-matesther-50 p-3 text-xs text-matesther-800">Create a separate batch for each garment size and colour. This keeps quantity, assigned worker and agreed piecework rate together. The eight production stages are created automatically.</p>
          <Field label="Uniform item *">
            <select required value={batchForm.orderItemId} onChange={(e) => {
              const item = items.find((x: any) => String(x.id) === e.target.value);
              setBatchForm((current) => ({ ...current, orderItemId: e.target.value, size: "", quantity: item ? String(item.quantity) : "" }));
            }} className={inputCls}>
              <option value="">Choose garment</option>
              {items.map((item: any) => <option key={item.id} value={item.id}>{item.productName} ({item.quantity} ordered)</option>)}
            </select>
          </Field>
          <Field label="Size for this batch">
            {(sizesData[Number(batchForm.orderItemId)] ?? []).length ? (
              <select value={batchForm.size} required={!!batchForm.tailorId} onChange={(e) => {
                const size = (sizesData[Number(batchForm.orderItemId)] ?? []).find((row: any) => row.size === e.target.value);
                const allocated = batches.filter((batch: any) => batch.orderItemId === Number(batchForm.orderItemId) && batch.size === e.target.value && batch.status !== "CANCELLED").reduce((sum: number, batch: any) => sum + batch.quantity, 0);
                setBatchForm((current) => ({ ...current, size: e.target.value, quantity: size ? String(Math.max(0, size.quantity - allocated)) : current.quantity }));
              }} className={inputCls}>
                <option value="">Choose size</option>
                {(sizesData[Number(batchForm.orderItemId)] ?? []).map((row: any) => <option key={row.id} value={row.size}>{row.size}: {row.quantity} ordered</option>)}
              </select>
            ) : <input value={batchForm.size} onChange={(e) => setBatchForm({ ...batchForm, size: e.target.value })} className={inputCls} placeholder="e.g. S, M or age 6 (optional)" />}
          </Field>
          <Field label="Colour / house colour">
            <input list="matesther-colours" value={batchForm.color} onChange={(e) => setBatchForm({ ...batchForm, color: e.target.value })} className={inputCls} placeholder="e.g. Navy blue" />
            <datalist id="matesther-colours"><option value="Navy blue"/><option value="White"/><option value="Grey"/><option value="Maroon"/><option value="Red"/><option value="Green"/><option value="Yellow"/></datalist>
          </Field>
          <Field label="Quantity in this batch *"><input type="number" min="1" step="1" required value={batchForm.quantity} onChange={(e) => setBatchForm({ ...batchForm, quantity: e.target.value })} className={inputCls} /></Field>
          <div className="sm:col-span-2 mt-1 border-t border-slate-100 pt-4 text-xs font-bold uppercase tracking-wide text-matesther-800">Cutting assignment</div>
          <Field label="Cutter">
            <select value={batchForm.workerId} onChange={(e) => setBatchForm({ ...batchForm, workerId: e.target.value, cuttingRate: "" })} className={inputCls}>
              <option value="">Assign later</option>
              {workers.filter((w) => w.status === "ACTIVE" && personHoldsRole(w, "Cutter")).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          {workers.find((w) => String(w.id) === batchForm.workerId)?.paymentType === "PER_PIECE" && <Field label="Agreed cutting pay per garment (₦) *">
            <input type="number" min="1" step="1" required value={batchForm.cuttingRate} onChange={(e) => setBatchForm({ ...batchForm, cuttingRate: e.target.value })} className={inputCls} />
          </Field>}
          <div className="sm:col-span-2 mt-1 border-t border-slate-100 pt-4 text-xs font-bold uppercase tracking-wide text-matesther-800">Sewing assignment</div>
          <Field label="Tailor">
            <select value={batchForm.tailorId} onChange={(e) => setBatchForm({ ...batchForm, tailorId: e.target.value, sewingRate: "" })} className={inputCls}>
              <option value="">Assign after cutting</option>
              {workers.filter((w) => w.status === "ACTIVE" && personHoldsRole(w, "Tailor")).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          {workers.find((w) => String(w.id) === batchForm.tailorId)?.paymentType === "PER_PIECE" && <Field label="Agreed sewing pay per garment (₦) *">
            <input type="number" min="1" step="1" required value={batchForm.sewingRate} onChange={(e) => setBatchForm({ ...batchForm, sewingRate: e.target.value })} className={inputCls} />
          </Field>}
          {batchForm.tailorId && <p className="sm:col-span-2 text-xs text-slate-500">The Tailor sees this batch's selected size and colour. Sewing becomes ready when approved pieces move from Cutting.</p>}
          <Field label="Target completion date"><input type="date" value={batchForm.expectedCompletionDate} onChange={(e) => setBatchForm({ ...batchForm, expectedCompletionDate: e.target.value })} className={inputCls} /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600" role="alert">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2"><Btn variant="secondary" onClick={() => setBatchModal(false)}>Cancel</Btn><Btn type="submit" disabled={saving}>{saving ? "Creating..." : "Start batch"}</Btn></div>
        </form>
      </Modal>

      {/* Payment */}
      <Modal open={payModal} onClose={() => setPayModal(false)} title="Record Customer Payment">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post("/api/payments", { orderId: Number(id), amount: Number(payForm.amount), paymentDate: payForm.paymentDate, paymentMethod: payForm.paymentMethod, reference: payForm.reference, notes: payForm.notes });
            if (r) { setPayModal(false); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Amount (₦) *"><input type="number" min="1" required value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} className={inputCls} /></Field>
          <Field label="Payment date"><input type="date" value={payForm.paymentDate} onChange={(e) => setPayForm({ ...payForm, paymentDate: e.target.value })} className={inputCls} /></Field>
          <Field label="Method">
            <select value={payForm.paymentMethod} onChange={(e) => setPayForm({ ...payForm, paymentMethod: e.target.value })} className={inputCls}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Reference / receipt no"><input value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} className={inputCls} placeholder="MTH-REC-…" /></Field>
          <Field label="Notes" className="sm:col-span-2"><input value={payForm.notes} onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })} className={inputCls} placeholder="e.g. Second instalment" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setPayModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Payment"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Expense */}
      <Modal open={expModal} onClose={() => setExpModal(false)} title="Add Expense to this order">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post("/api/expenses", { orderId: Number(id), category: expForm.category, description: expForm.description, amount: Number(expForm.amount), expenseDate: expForm.expenseDate, notes: expForm.notes });
            if (r) { setExpModal(false); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Category">
            <select value={expForm.category} onChange={(e) => setExpForm({ ...expForm, category: e.target.value })} className={inputCls}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Amount (₦) *"><input type="number" min="1" required value={expForm.amount} onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })} className={inputCls} /></Field>
          <Field label="Description *" className="sm:col-span-2"><input required value={expForm.description} onChange={(e) => setExpForm({ ...expForm, description: e.target.value })} className={inputCls} placeholder="e.g. Sewing labour - 250 shirts" /></Field>
          <Field label="Date"><input type="date" value={expForm.expenseDate} onChange={(e) => setExpForm({ ...expForm, expenseDate: e.target.value })} className={inputCls} /></Field>
          <Field label="Notes"><input value={expForm.notes} onChange={(e) => setExpForm({ ...expForm, notes: e.target.value })} className={inputCls} /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setExpModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Add Expense"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Purchase */}
      <Modal open={purModal} onClose={() => setPurModal(false)} title="Record Material Purchase (linked to this order)">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post("/api/material-purchases", { orderId: Number(id), materialId: Number(purForm.materialId), supplier: purForm.supplier, quantity: Number(purForm.quantity), unitCost: Number(purForm.unitCost), purchaseDate: purForm.purchaseDate, notes: purForm.notes });
            if (r) { setPurModal(false); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Material *">
            <select required value={purForm.materialId} onChange={(e) => {
              const m = materials.find((x) => String(x.id) === e.target.value);
              setPurForm({ ...purForm, materialId: e.target.value, unitCost: m ? String(m.unitCost) : purForm.unitCost });
            }} className={inputCls}>
              <option value="">Select…</option>
              {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
            </select>
          </Field>
          <Field label="Supplier"><input value={purForm.supplier} onChange={(e) => setPurForm({ ...purForm, supplier: e.target.value })} className={inputCls} placeholder="e.g. Ariaria Fabric Depot" /></Field>
          <Field label="Quantity *"><input type="number" min="1" required value={purForm.quantity} onChange={(e) => setPurForm({ ...purForm, quantity: e.target.value })} className={inputCls} /></Field>
          <Field label="Unit cost (₦) *"><input type="number" min="0" required value={purForm.unitCost} onChange={(e) => setPurForm({ ...purForm, unitCost: e.target.value })} className={inputCls} /></Field>
          <Field label="Purchase date"><input type="date" value={purForm.purchaseDate} onChange={(e) => setPurForm({ ...purForm, purchaseDate: e.target.value })} className={inputCls} /></Field>
          <Field label="Notes"><input value={purForm.notes} onChange={(e) => setPurForm({ ...purForm, notes: e.target.value })} className={inputCls} placeholder="e.g. Additional - fabric ran short" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
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
            const r = await post("/api/material-usage", { orderId: Number(id), materialId: Number(useForm.materialId), productionOperationId: useForm.productionOperationId || null, quantityUsed: Number(useForm.quantityUsed), unitCost: useForm.unitCost === "" ? undefined : Number(useForm.unitCost) });
            if (r) { setUseModal(false); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Material *">
            <select required value={useForm.materialId} onChange={(e) => {
              const m = materials.find((x) => String(x.id) === e.target.value);
              setUseForm({ ...useForm, materialId: e.target.value, unitCost: m ? String(m.unitCost) : useForm.unitCost });
            }} className={inputCls}>
              <option value="">Select…</option>
              {materials.map((m) => <option key={m.id} value={m.id}>{m.name} - stock {m.currentStock} {m.unit}</option>)}
            </select>
          </Field>
          <Field label="Stage (optional)">
            <select value={useForm.productionOperationId} onChange={(e) => setUseForm({ ...useForm, productionOperationId: e.target.value })} className={inputCls}>
              <option value="">General to order</option>
              {batches.flatMap((b: any) => b.operations.map((o: any) => <option key={o.id} value={o.id}>{b.batchNumber} - {stageLabel(o.stage)}</option>))}
            </select>
          </Field>
          <Field label="Quantity used *"><input type="number" min="1" required value={useForm.quantityUsed} onChange={(e) => setUseForm({ ...useForm, quantityUsed: e.target.value })} className={inputCls} /></Field>
          <Field label="Unit cost (₦)"><input type="number" min="0" value={useForm.unitCost} onChange={(e) => setUseForm({ ...useForm, unitCost: e.target.value })} className={inputCls} /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setUseModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Usage"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Edit order */}
      <Modal open={editModal} onClose={() => setEditModal(false)} title="Edit Order" wide>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const clean = editItems.filter((i) => i.productId && Number(i.quantity) > 0);
            const r = await post(`/api/orders/${id}`, { ...editForm, items: clean.map((i) => ({ productId: Number(i.productId), quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), notes: i.notes })) }, "PUT");
            if (r) { setEditModal(false); load(); }
          }}
          className="space-y-3"
        >
          <div className="grid sm:grid-cols-4 gap-3">
            <Field label="Customer">
              <select value={editForm.customerId} onChange={(e) => setEditForm({ ...editForm, customerId: e.target.value })} className={inputCls}>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Order date"><input type="date" value={editForm.orderDate || ""} onChange={(e) => setEditForm({ ...editForm, orderDate: e.target.value })} className={inputCls} /></Field>
            <Field label="Due date"><input type="date" value={editForm.dueDate || ""} onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })} className={inputCls} /></Field>
            <Field label="Status">
              <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })} className={inputCls}>
                <option value="PENDING">Pending</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="COMPLETED">Completed</option>
                <option value="ON_HOLD">On Hold</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </Field>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-600 mb-2">Products</p>
            <div className="space-y-2">
              {editItems.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2">
                  <select value={it.productId} onChange={(e) => { const n = [...editItems]; n[idx].productId = e.target.value; const p = products.find((x) => String(x.id) === e.target.value); if (p) n[idx].unitPrice = String(p.sellingPrice); setEditItems(n); }} className={`${inputCls} col-span-6`}>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input type="number" min="1" value={it.quantity} onChange={(e) => { const n = [...editItems]; n[idx].quantity = e.target.value; setEditItems(n); }} className={`${inputCls} col-span-2`} placeholder="Qty" />
                  <input type="number" min="0" value={it.unitPrice} onChange={(e) => { const n = [...editItems]; n[idx].unitPrice = e.target.value; setEditItems(n); }} className={`${inputCls} col-span-3`} placeholder="Unit ₦" />
                  <button type="button" onClick={() => setEditItems(editItems.filter((_, i) => i !== idx))} className="col-span-1 text-red-600 text-lg">×</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setEditItems([...editItems, { productId: products[0] ? String(products[0].id) : "", quantity: "", unitPrice: products[0] ? String(products[0].sellingPrice) : "", notes: "" }])} className="mt-2 text-xs font-semibold text-matesther-700 hover:underline">+ Add product</button>
          </div>
          <Field label="Notes"><textarea value={editForm.notes || ""} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} className={inputCls} rows={2} /></Field>
          {formErr && <p className="text-sm text-red-600">{formErr}</p>}
          <div className="flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setEditModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Changes"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Sizes manager */}
      <Modal open={!!sizesItem} onClose={() => setSizesItem(null)} title={`Size breakdown - ${sizesItem?.productName || ""}`}>
        <form onSubmit={saveSizes} className="space-y-3">
          <p className="text-xs text-slate-500">
            How many of each size were ordered (should total the item quantity), and how many of
            each are finished so far.
          </p>
          <div className="text-[10px] font-bold uppercase text-slate-400 grid grid-cols-12 gap-2">
            <span className="col-span-4">Size</span>
            <span className="col-span-3">Ordered</span>
            <span className="col-span-3">Finished</span>
            <span className="col-span-2" />
          </div>
          {sizeRows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-center">
              <input value={r.size} onChange={(e) => { const n = [...sizeRows]; n[i] = { ...r, size: e.target.value }; setSizeRows(n); }} placeholder="Size (S, M, 4-5…)" className={`${inputCls} col-span-4`} />
              <input type="number" min="0" value={r.quantity} onChange={(e) => { const n = [...sizeRows]; n[i] = { ...r, quantity: e.target.value }; setSizeRows(n); }} placeholder="Ordered" className={`${inputCls} col-span-3`} />
              <input type="number" min="0" value={r.completed} onChange={(e) => { const n = [...sizeRows]; n[i] = { ...r, completed: e.target.value }; setSizeRows(n); }} placeholder="Finished" className={`${inputCls} col-span-3`} />
              <button type="button" onClick={() => setSizeRows(sizeRows.filter((_, x) => x !== i))} className="col-span-2 text-red-600 text-xs font-semibold text-center">Remove</button>
            </div>
          ))}
          <button type="button" onClick={() => setSizeRows([...sizeRows, { size: "", quantity: "", completed: "0" }])} className="text-xs font-semibold text-matesther-700 hover:underline">
            + Add size
          </button>
          <div className="flex justify-end gap-2 pt-2">
            <Btn variant="secondary" onClick={() => setSizesItem(null)}>Cancel</Btn>
            <Btn type="submit">Save sizes</Btn>
          </div>
        </form>
      </Modal>

      {/* Inspect (quality gate - approved pieces only move forward) */}
      <Modal open={!!inspModal} onClose={() => setInspModal(null)} title={inspModal ? `Inspect - ${stageLabel(inspModal.stage)} (${inspModal.batchNumber || ""})` : ""}>
        {inspModal && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await post("/api/inspections", {
                operationId: inspModal.id,
                quantityApproved: Number(inspForm.quantityApproved) || 0,
                quantityRework: Number(inspForm.quantityRework) || 0,
                quantityRejected: Number(inspForm.quantityRejected) || 0,
                notes: inspForm.notes,
                inspectedBy: user?.name || "Owner",
              });
              if (r) { setInspModal(null); load(); }
            }}
            className="grid sm:grid-cols-3 gap-3"
          >
            <p className="sm:col-span-3 text-xs text-slate-500 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2">
              {inspModal.pendingInspection} piece(s) submitted by {inspModal.workerName || "worker"} are awaiting inspection.
              Record the result - <span className="font-semibold">only approved pieces move to the next stage</span>. Rework returns to the worker; rejected pieces stay recorded.
            </p>
            <Field label="Approved ✓"><input type="number" min="0" value={inspForm.quantityApproved} onChange={(e) => setInspForm({ ...inspForm, quantityApproved: e.target.value })} className={`${inputCls} border-emerald-300`} /></Field>
            <Field label="Rework required ↺"><input type="number" min="0" value={inspForm.quantityRework} onChange={(e) => setInspForm({ ...inspForm, quantityRework: e.target.value })} className={`${inputCls} border-amber-300`} /></Field>
            <Field label="Rejected ✗"><input type="number" min="0" value={inspForm.quantityRejected} onChange={(e) => setInspForm({ ...inspForm, quantityRejected: e.target.value })} className={`${inputCls} border-red-300`} /></Field>
            <p className="sm:col-span-3 text-xs font-semibold text-slate-600">
              Total: {(Number(inspForm.quantityApproved) || 0) + (Number(inspForm.quantityRework) || 0) + (Number(inspForm.quantityRejected) || 0)} of {inspModal.pendingInspection} available
            </p>
            <Field label="Inspection notes" className="sm:col-span-3"><textarea value={inspForm.notes} onChange={(e) => setInspForm({ ...inspForm, notes: e.target.value })} className={inputCls} rows={2} placeholder="e.g. 5 sent back for loose side seams" /></Field>
            {formErr && <p className="sm:col-span-3 text-sm text-red-600">{formErr}</p>}
            <div className="sm:col-span-3 flex justify-end gap-2">
              <Btn variant="secondary" onClick={() => setInspModal(null)}>Cancel</Btn>
              <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Inspection"}</Btn>
            </div>
          </form>
        )}
      </Modal>

      {/* QC */}
      <Modal open={!!qcModal} onClose={() => setQcModal(null)} title={qcModal ? `Quality check - ${stageLabel(qcModal.stage)}` : ""}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post("/api/quality", { productionOperationId: qcModal.id, quantityChecked: Number(qcForm.quantityChecked), quantityPassed: Number(qcForm.quantityPassed), notes: qcForm.notes });
            if (r) { setQcModal(null); setTab("quality"); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Quantity checked *"><input type="number" min="1" required value={qcForm.quantityChecked} onChange={(e) => setQcForm({ ...qcForm, quantityChecked: e.target.value })} className={inputCls} /></Field>
          <Field label="Quantity passed *"><input type="number" min="0" required value={qcForm.quantityPassed} onChange={(e) => setQcForm({ ...qcForm, quantityPassed: e.target.value })} className={inputCls} /></Field>
          <Field label="Notes" className="sm:col-span-2"><input value={qcForm.notes} onChange={(e) => setQcForm({ ...qcForm, notes: e.target.value })} className={inputCls} placeholder="e.g. 4 shirts failed seam check" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setQcModal(null)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Check"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Rework */}
      <Modal open={!!rwModal} onClose={() => setRwModal(null)} title={rwModal ? `Send for rework - ${stageLabel(rwModal.stage)}` : ""}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post("/api/quality", { kind: "rework", productionOperationId: rwModal.id, quantity: Number(rwForm.quantity), reason: rwForm.reason, status: rwForm.status });
            if (r) { setRwModal(null); setTab("quality"); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Quantity *"><input type="number" min="1" required value={rwForm.quantity} onChange={(e) => setRwForm({ ...rwForm, quantity: e.target.value })} className={inputCls} /></Field>
          <Field label="Status">
            <select value={rwForm.status} onChange={(e) => setRwForm({ ...rwForm, status: e.target.value })} className={inputCls}>
              <option value="PENDING">Pending</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="FIXED">Fixed</option>
            </select>
          </Field>
          <Field label="Reason" className="sm:col-span-2"><input value={rwForm.reason} onChange={(e) => setRwForm({ ...rwForm, reason: e.target.value })} className={inputCls} placeholder="e.g. Loose side seams" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setRwModal(null)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Rework"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Packing */}
      <Modal open={packModal} onClose={() => setPackModal(false)} title="Record Packing">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post("/api/packing", { orderId: Number(id), quantityPacked: Number(packForm.quantityPacked), packageCount: Number(packForm.packageCount), notes: packForm.notes });
            if (r) { setPackModal(false); load(); }
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <Field label="Quantity packed *"><input type="number" min="1" required value={packForm.quantityPacked} onChange={(e) => setPackForm({ ...packForm, quantityPacked: e.target.value })} className={inputCls} /></Field>
          <Field label="Package count"><input type="number" min="0" value={packForm.packageCount} onChange={(e) => setPackForm({ ...packForm, packageCount: e.target.value })} className={inputCls} placeholder="e.g. 12 bundles" /></Field>
          <Field label="Notes" className="sm:col-span-2"><input value={packForm.notes} onChange={(e) => setPackForm({ ...packForm, notes: e.target.value })} className={inputCls} placeholder="e.g. 10 per bundle, labelled by class" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setPackModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Packing"}</Btn>
          </div>
        </form>
      </Modal>

      {/* Delivery */}
      <Modal open={delModal} onClose={() => setDelModal(false)} title="Record School Delivery" wide>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const lines = deliveryLines.filter((row) => row.orderItemId && Number(row.quantity) > 0)
              .map((row) => ({ orderItemId: Number(row.orderItemId), size: row.size, quantity: Number(row.quantity) }));
            if (!lines.length) { setFormErr("Enter at least one garment and quantity for this delivery."); return; }
            const saved = await post("/api/deliveries", {
              orderId: Number(id), deliveryDate: delForm.deliveryDate,
              recipient: delForm.recipient, deliveryAddress: delForm.deliveryAddress,
              status: delForm.status, notes: delForm.notes, lines,
            });
            if (saved) { setDelModal(false); setLastDeliveryId(saved.id); setTab("delivery"); load(); }
          }}
          className="grid gap-3 sm:grid-cols-2"
        >
          <p className="sm:col-span-2 text-xs text-slate-500">This shipment is separate from earlier deliveries. The school sheet will list only the garment and size rows you record here. {Math.max(0, totalQuantity - deliveredQuantity)} garments remain on the order.</p>
          <Field label="Delivery date"><input required type="date" value={delForm.deliveryDate} onChange={(e) => setDelForm({ ...delForm, deliveryDate: e.target.value })} className={inputCls} /></Field>
          <Field label="Delivery status">
            <select value={delForm.status} onChange={(e) => setDelForm({ ...delForm, status: e.target.value })} className={inputCls}>
              <option value="DELIVERED">Delivered</option><option value="PARTIAL">Part delivery</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <p className="mb-2 text-xs font-semibold text-slate-700">Uniforms handed over</p>
            {deliveryLines.map((line, index) => {
              const availableSizes = sizesData[Number(line.orderItemId)] ?? [];
              return <div key={index} className="mb-2 grid grid-cols-12 gap-2">
                <select required value={line.orderItemId} onChange={(e) => setDeliveryLines((rows) => rows.map((row, idx) => idx === index ? { ...row, orderItemId: e.target.value, size: "" } : row))} className={`${inputCls} col-span-5`}>
                  <option value="">Choose garment</option>
                  {items.map((item: any) => <option key={item.id} value={item.id}>{item.productName}</option>)}
                </select>
                {availableSizes.length ? (
                  <select value={line.size} onChange={(e) => setDeliveryLines((rows) => rows.map((row, idx) => idx === index ? { ...row, size: e.target.value } : row))} className={`${inputCls} col-span-3`} aria-label="Garment size">
                    <option value="">Assorted</option>
                    {availableSizes.map((size: any) => <option key={size.id} value={size.size}>{size.size}</option>)}
                  </select>
                ) : (
                  <input value={line.size} onChange={(e) => setDeliveryLines((rows) => rows.map((row, idx) => idx === index ? { ...row, size: e.target.value } : row))} placeholder="Size" aria-label="Garment size (optional)" className={`${inputCls} col-span-3`} />
                )}
                <input required type="number" min="1" step="1" value={line.quantity} onChange={(e) => setDeliveryLines((rows) => rows.map((row, idx) => idx === index ? { ...row, quantity: e.target.value } : row))} placeholder="Qty" aria-label="Garment quantity" className={`${inputCls} col-span-3`} />
                <button type="button" onClick={() => setDeliveryLines((rows) => rows.filter((_, idx) => idx !== index))} disabled={deliveryLines.length === 1} aria-label="Remove this garment line" className="col-span-1 rounded-lg text-sm font-bold text-red-600 disabled:opacity-30">×</button>
              </div>;
            })}
            <button type="button" onClick={() => setDeliveryLines((rows) => [...rows, { orderItemId: items[0] ? String(items[0].id) : "", size: "", quantity: "" }])} className="text-xs font-bold text-matesther-700 hover:underline">+ Add another garment or size</button>
            <p className="mt-2 text-sm font-bold text-matesther-800">This delivery: {deliveryLines.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0).toLocaleString()} garments</p>
          </div>
          <Field label="Recipient at school"><input value={delForm.recipient} onChange={(e) => setDelForm({ ...delForm, recipient: e.target.value })} className={inputCls} placeholder="Name of person receiving" /></Field>
          <Field label="Delivery address"><input value={delForm.deliveryAddress} onChange={(e) => setDelForm({ ...delForm, deliveryAddress: e.target.value })} className={inputCls} /></Field>
          <Field label="Delivery notes" className="sm:col-span-2"><input value={delForm.notes} onChange={(e) => setDelForm({ ...delForm, notes: e.target.value })} className={inputCls} placeholder="e.g. Waybill number, package count" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600" role="alert">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setDelModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving..." : "Save delivery and prepare sheet"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
