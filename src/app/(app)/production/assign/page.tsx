"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Plus, Scissors } from "lucide-react";
import { Card, Field, Loading, PageHeader, inputCls, Btn } from "@/components/ui";
import { fmtDate, personHoldsRole } from "@/lib/format";

type ProductionItem = { id: number; name: string; quantity: number; sizes: { size: string; quantity: number }[];
  assigned: { size: string | null; color: string | null; quantity: number }[] };
type ProductionOrder = { id: number; customer: string; orderNumber: string; dueDate: string | null; status: string; items: ProductionItem[] };
type Worker = { id: number; name: string; specialty: string; roles?: string[]; paymentType: string; status: string };
type Form = { orderId: string; itemId: string; size: string; color: string; quantity: string; cutterId: string;
  cuttingRate: string; tailorId: string; sewingRate: string; expectedCompletionDate: string };
const newForm = (): Form => ({ orderId: "", itemId: "", size: "", color: "", quantity: "", cutterId: "", cuttingRate: "", tailorId: "", sewingRate: "", expectedCompletionDate: "" });

export default function AssignProductionPage() {
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [canAssignCutting, setCanAssignCutting] = useState(false);
  const [form, setForm] = useState<Form>(newForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [orderResponse, workerResponse, accessResponse] = await Promise.all([
        fetch("/api/production-orders", { cache: "no-store" }),
        fetch("/api/workers", { cache: "no-store" }),
        fetch("/api/production-access", { cache: "no-store" }),
      ]);
      const [orderData, workerData, accessData] = await Promise.all([orderResponse.json(), workerResponse.json(), accessResponse.json()]);
      if (!orderResponse.ok) throw new Error(orderData.error || "Could not load production orders.");
      if (!workerResponse.ok) throw new Error(workerData.error || "Could not load available workers.");
      if (!accessResponse.ok) throw new Error(accessData.error || "Could not verify assignment permissions.");
      const cuttingAllowed = accessData.canAssignCutting === true;
      setCanAssignCutting(cuttingAllowed);
      if (!cuttingAllowed) setForm((current) => ({ ...current, cutterId: "", cuttingRate: "" }));
      setOrders(Array.isArray(orderData) ? orderData : []);
      setWorkers(Array.isArray(workerData) ? workerData : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load assignment options.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const order = orders.find((record) => String(record.id) === form.orderId);
  const item = order?.items.find((record) => String(record.id) === form.itemId);
  const size = item?.sizes.find((entry) => entry.size === form.size);
  const previouslyAssigned = item?.assigned.filter((batch) => !item.sizes.length || batch.size === form.size)
    .reduce((sum, batch) => sum + batch.quantity, 0) ?? 0;
  const totalAssigned = item?.assigned.reduce((sum, batch) => sum + batch.quantity, 0) ?? 0;
  const available = Math.max(0, Math.min(
    (size?.quantity ?? item?.quantity ?? 0) - previouslyAssigned,
    (item?.quantity ?? 0) - totalAssigned,
  ));
  const cutter = workers.find((person) => String(person.id) === form.cutterId);
  const tailor = workers.find((person) => String(person.id) === form.tailorId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaved("");
    if (!order || !item) return setError("Select a school order and uniform garment.");
    const quantity = Number(form.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > available)
      return setError(available ? `Choose between 1 and ${available} garments available for this batch.` : "All garments on this item have already been assigned to production.");
    if (item.sizes.length && tailor && !form.size) return setError("Choose the size being assigned to the Tailor.");
    setSaving(true);
    try {
      const response = await fetch("/api/batches", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: order.id, orderItemId: item.id, quantity,
          size: form.size, color: form.color.trim(), workerId: canAssignCutting ? form.cutterId || null : null,
          cuttingRate: canAssignCutting && cutter?.paymentType === "PER_PIECE" ? Number(form.cuttingRate) : null,
          tailorId: form.tailorId || null,
          sewingRate: tailor?.paymentType === "PER_PIECE" ? Number(form.sewingRate) : null,
          expectedCompletionDate: form.expectedCompletionDate || null,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not start production.");
      setSaved(`${result.batchNumber} created for ${order.customer}: ${quantity} ${item.name}${form.size ? `, size ${form.size}` : ""}.`);
      setForm((current) => ({ ...current, size: "", quantity: "", cuttingRate: "", sewingRate: "" }));
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start production."); }
    finally { setSaving(false); }
  }

  return <div className="mx-auto max-w-4xl">
    <PageHeader title="Assign Production" subtitle="Give work to Cutters and Tailors by school, garment, size and colour. Agree the pay for this particular batch." />
    {loading ? <Card><Loading label="Loading school orders and available staff..." /></Card> :
      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 bg-matesther-50/70 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-bold text-matesther-900"><Scissors className="h-4 w-4" /> New production batch</p>
          <p className="mt-1 text-xs text-slate-600">Each batch has the eight Matesther production stages. Only approved pieces move to the next stage.</p>
        </div>
        <form onSubmit={submit} className="space-y-5 p-4 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="1. School order *"><select className={inputCls} required value={form.orderId} onChange={(event) => {
              const chosen = orders.find((entry) => String(entry.id) === event.target.value);
              setForm({ ...newForm(), orderId: event.target.value, expectedCompletionDate: chosen?.dueDate ?? "" }); setSaved("");
            }}><option value="">Choose school order</option>
              {orders.map((record) => <option key={record.id} value={record.id}>{record.customer} | {record.orderNumber}</option>)}
            </select></Field>
            <Field label="2. Garment *"><select className={inputCls} required disabled={!order} value={form.itemId} onChange={(event) => {
              const selectedItem = order?.items.find((entry) => String(entry.id) === event.target.value);
              setForm((current) => ({ ...current, itemId: event.target.value, size: "", quantity: selectedItem?.sizes.length ? "" : String(Math.max(0, (selectedItem?.quantity ?? 0) - (selectedItem?.assigned.reduce((sum, batch) => sum + batch.quantity, 0) ?? 0))) }));
            }}><option value="">Choose garment</option>{order?.items.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} | {entry.quantity} ordered</option>)}</select></Field>
            <Field label="3. Size">{item?.sizes.length ? <select className={inputCls} value={form.size} required={!!tailor} onChange={(event) => {
              const selectedSize = item.sizes.find((entry) => entry.size === event.target.value);
              const reserved = item.assigned.filter((batch) => batch.size === event.target.value).reduce((sum, batch) => sum + batch.quantity, 0);
              const overallRemaining = item.quantity - item.assigned.reduce((sum, batch) => sum + batch.quantity, 0);
              setForm((current) => ({ ...current, size: event.target.value, quantity: selectedSize ? String(Math.max(0, Math.min(selectedSize.quantity - reserved, overallRemaining))) : "" }));
            }}><option value="">Choose size</option>{item.sizes.map((entry) => <option key={entry.size} value={entry.size}>{entry.size} | {entry.quantity} ordered</option>)}</select> :
              <input className={inputCls} value={form.size} onChange={(event) => setForm({ ...form, size: event.target.value })} placeholder="e.g. M, XL, age 6" />}</Field>
            <Field label="4. Colour"><input className={inputCls} value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} placeholder="e.g. White, Navy, House Red" /></Field>
            <Field label="5. Quantity in this batch *"><input className={inputCls} type="number" min="1" max={available || undefined} step="1" required value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></Field>
            <div className="self-end rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{item ? <><strong>{available}</strong> garment{available === 1 ? "" : "s"} left to allocate{size ? ` for size ${size.size}` : ""}.</> : "Select a garment to see the available quantity."}{order?.dueDate && <span className="block mt-1">School deadline: {fmtDate(order.dueDate)}</span>}</div>
          </div>
          <div className="rounded-xl border border-slate-200 p-4"><p className="mb-3 text-sm font-bold text-slate-800">Cutting assignment</p>
            {canAssignCutting ? <div className="grid gap-3 sm:grid-cols-2"><Field label="Cutter"><select className={inputCls} value={form.cutterId} onChange={(event) => setForm({ ...form, cutterId: event.target.value, cuttingRate: "" })}><option value="">Assign later</option>{workers.filter((person) => person.status === "ACTIVE" && personHoldsRole(person, "Cutter")).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
              {cutter?.paymentType === "PER_PIECE" && <Field label="Agreed pay per approved piece (₦) *"><input className={inputCls} type="number" min="1" step="1" required value={form.cuttingRate} onChange={(event) => setForm({ ...form, cuttingRate: event.target.value })} /></Field>}
            </div> : <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-relaxed text-amber-900">As a cutter-supervisor, you can prepare this batch and assign its Tailor. The Owner or a non-cutting supervisor must choose the Cutter and their agreed rate before Cutting begins.</p>}
          </div>
          <div className="rounded-xl border border-slate-200 p-4"><p className="mb-3 text-sm font-bold text-slate-800">Sewing assignment</p>
            <div className="grid gap-3 sm:grid-cols-2"><Field label="Tailor"><select className={inputCls} value={form.tailorId} onChange={(event) => setForm({ ...form, tailorId: event.target.value, sewingRate: "" })}><option value="">Assign after cutting</option>{workers.filter((person) => person.status === "ACTIVE" && personHoldsRole(person, "Tailor")).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
              {tailor?.paymentType === "PER_PIECE" && <Field label="Agreed pay per approved piece (₦) *"><input className={inputCls} type="number" min="1" step="1" required value={form.sewingRate} onChange={(event) => setForm({ ...form, sewingRate: event.target.value })} /></Field>}
            </div>
            {tailor && item?.sizes.length ? <p className="mt-2 text-xs text-slate-500">Choose a size above. Create another batch for another size or colour.</p> : null}
          </div>
          <Field label="Expected completion date"><input className={`${inputCls} max-w-xs`} type="date" value={form.expectedCompletionDate} onChange={(event) => setForm({ ...form, expectedCompletionDate: event.target.value })} /></Field>
          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error} <button type="button" className="font-semibold underline" onClick={() => void load()}>Refresh orders</button></div>}
          {saved && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{saved}</span><Link href="/production?stage=CUTTING" className="inline-flex items-center gap-1 font-bold underline">Open production <ArrowRight className="h-4 w-4" /></Link></div>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4"><p className="text-xs text-slate-500">Need to assign another stage? Open a card in Active Production.</p><Btn type="submit" disabled={saving || !orders.length}><Plus className="h-4 w-4" /> {saving ? "Creating..." : "Start batch"}</Btn></div>
        </form>
      </Card>}
  </div>;
}
