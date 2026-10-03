"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Package, Send, Truck } from "lucide-react";
import { Badge, Btn, Card, EmptyState, Field, Loading, Modal, PageHeader, inputCls } from "@/components/ui";
import { fmtDate, methodLabel } from "@/lib/format";

/**
 * EXTERNAL WORK AND READY-MADE RECEIPTS.
 *
 * Two different business facts, kept visibly apart on purpose:
 *
 *   EXTERNAL WORK - Matesther's garment goes OUT to be made or processed and comes
 *   back. Four separate figures are tracked because they are four separate facts:
 *   sent, returned, accepted, and short. 100 sent / 96 returned / 94 accepted /
 *   2 damaged / 4 never arrived is a normal outcome and every number is kept.
 *   Only the ACCEPTED figure moves on to the next stage of the route.
 *
 *   READY-MADE RECEIPTS - a finished garment is BOUGHT IN. That is a purchase with
 *   its own cost, recorded against the purchase it came from. It is not labour and
 *   it is not outsourcing, so it never appears as tailor piecework and never as an
 *   external production cost.
 */

type Dispatch = {
  id: number; vendorName: string; stage: string; method: string; methodLabel: string; status: string;
  quantitySent: number; quantityReturned: number; quantityAccepted: number; quantityRejected: number; quantityShort: number;
  unitCost: number | null; totalCost: number | null; sentAt: string | null; returnedAt: string | null;
  sentBy: string | null; acceptedBy: string | null; notes: string | null;
  batchNumber: string; variant: string; orderNumber: string; customer: string; dueDate: string | null;
};
type Receipt = {
  id: number; garment: string; category: string | null; supplier: string | null; quantity: number;
  unitCost: number; totalCost: number; purchaseDate: string; stage: string | null; stageStatus: string | null;
  batchNumber: string; orderNumber: string; variant: string; notes: string | null;
};
type Job = {
  id: number; stage: string; method: string; methodLabel: string; status: string; batchNumber: string;
  variant: string; orderNumber: string; customer: string; quantityReceived: number; quantityRemaining: number;
  quantityApproved: number; routePosition: number | null; routeLength: number;
};

export default function ExternalWorkPage() {
  const [tab, setTab] = useState<"external" | "readyMade">("external");
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState<Job | null>(null);
  const [sendForm, setSendForm] = useState({ vendorName: "", quantitySent: "", unitCost: "", notes: "" });
  const [returning, setReturning] = useState<Dispatch | null>(null);
  const [returnForm, setReturnForm] = useState({ quantityReturned: "", quantityAccepted: "", quantityRejected: "", quantityShort: "", notes: "" });
  const [buying, setBuying] = useState<Job | null>(null);
  const [buyForm, setBuyForm] = useState({ materialId: "", quantity: "", unitCost: "", supplier: "", notes: "" });
  const [judging, setJudging] = useState<Receipt | null>(null);
  const [judgeForm, setJudgeForm] = useState({ quantityAccepted: "", quantityRejected: "", notes: "" });
  const [materials, setMaterials] = useState<{ id: number; name: string; category: string | null }[]>([]);

  async function load() {
    // No leading setLoading(true): `loading` already starts true, so the first
    // paint shows the spinner without a synchronous setState inside the effect.
    // Reloads after a save keep their button-level busy indicator.
    try {
      const [externalResponse, receiptResponse, jobResponse, materialResponse] = await Promise.all([
        fetch("/api/external-work", { cache: "no-store" }),
        fetch("/api/ready-made", { cache: "no-store" }),
        fetch("/api/operations?status=PENDING,IN_PROGRESS,SUBMITTED,ON_HOLD", { cache: "no-store" }),
        fetch("/api/materials", { cache: "no-store" }),
      ]);
      const [externalData, receiptData, jobData, materialData] = await Promise.all([
        externalResponse.json(), receiptResponse.json(), jobResponse.json(), materialResponse.json(),
      ]);
      if (!externalResponse.ok || !receiptResponse.ok)
        throw new Error(externalData.error || receiptData.error || "Could not load external production work.");
      setDispatches(Array.isArray(externalData) ? externalData : []);
      setReceipts(Array.isArray(receiptData) ? receiptData : []);
      setJobs(Array.isArray(jobData) ? jobData : []);
      setMaterials(Array.isArray(materialData) ? materialData : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load external production work.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function post(url: string, body: unknown, method = "POST", okMessage = "") {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "That did not save.");
      if (okMessage) setNotice(okMessage);
      await load();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That did not save."); return false; }
    finally { setBusy(false); }
  }

  /** Stages whose work is done outside the factory and still has garments to send. */
  // MACHINE is Matesther's own equipment with an operator on it, so it is worked
  // and submitted like any in-house stage and is not listed here.
  const sendable = jobs.filter((job) => ["OUTSOURCED", "VENDOR_PROCESSING"].includes(job.method));
  /** Stages that are satisfied by buying a finished garment in. */
  const buyable = jobs.filter((job) => job.method === "READY_MADE");
  const finishedGarments = materials.filter((material) => String(material.category ?? "").toLowerCase() === "ready-made garment");
  const outstanding = (dispatch: Dispatch) => Math.max(0, dispatch.quantitySent - dispatch.quantityReturned - dispatch.quantityShort);

  return <div className="mx-auto max-w-6xl">
    <PageHeader
      title="External Work & Ready-made"
      subtitle="Work that leaves the factory, and finished garments bought in. Only what Matesther accepts moves on to the next stage."
      action={<Link href="/production" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-matesther-600"><ArrowLeft className="h-4 w-4" /> Production board</Link>}
    />

    {notice && <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />{notice}</div>}
    {error && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

    <div className="mb-4 grid grid-cols-2 gap-2">
      <button type="button" onClick={() => setTab("external")} aria-pressed={tab === "external"}
        className={`min-h-12 rounded-xl border p-2 text-sm font-semibold ${tab === "external" ? "border-matesther-800 bg-matesther-800 text-white" : "border-slate-200 bg-white text-slate-700"}`}>
        <Truck className="mr-1.5 inline h-4 w-4" /> Sent outside <span className="text-xs opacity-80">({dispatches.length})</span>
      </button>
      <button type="button" onClick={() => setTab("readyMade")} aria-pressed={tab === "readyMade"}
        className={`min-h-12 rounded-xl border p-2 text-sm font-semibold ${tab === "readyMade" ? "border-matesther-800 bg-matesther-800 text-white" : "border-slate-200 bg-white text-slate-700"}`}>
        <Package className="mr-1.5 inline h-4 w-4" /> Bought in finished <span className="text-xs opacity-80">({receipts.length})</span>
      </button>
    </div>

    {loading ? <Card><Loading label="Loading external work..." /></Card> : tab === "external" ? (
      <div className="space-y-4">
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-slate-900">Send work out</p>
              <p className="mt-0.5 text-xs text-slate-500">Stages on a route whose method is outsourced or external processing - work that physically leaves the factory.</p>
            </div>
          </div>
          {sendable.length === 0
            ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">No open stage is produced outside the factory. Set the method for a stage on its route under <Link href="/production/routes" className="font-semibold underline">Production routes</Link>.</p>
            : <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {sendable.map((job) => (
                  <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-800">{job.variant}</p>
                      <p className="text-[11px] text-slate-500">{job.orderNumber} • {job.batchNumber} • {methodLabel(job.method)}</p>
                      <p className="mt-0.5 text-[11px] text-slate-600">Holds {job.quantityReceived}, {job.quantityRemaining} still outstanding</p>
                    </div>
                    <Btn variant="secondary" onClick={() => { setSending(job); setSendForm({ vendorName: "", quantitySent: String(job.quantityRemaining || ""), unitCost: "", notes: "" }); }}><Send className="h-3.5 w-3.5" /> Send out</Btn>
                  </div>
                ))}
              </div>}
        </Card>

        {dispatches.length === 0
          ? <Card><EmptyState title="Nothing has been sent outside the factory yet" hint="When a stage is outsourced or processed by a vendor, record the dispatch here so what comes back can be counted." /></Card>
          : dispatches.map((dispatch) => (
              <Card key={dispatch.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900">{dispatch.vendorName}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {dispatch.variant} • {dispatch.orderNumber} • batch {dispatch.batchNumber} • {dispatch.methodLabel}
                      {dispatch.dueDate ? ` • due ${fmtDate(dispatch.dueDate)}` : ""}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      Sent {fmtDate(dispatch.sentAt)} by {dispatch.sentBy ?? "—"}
                      {dispatch.acceptedBy ? ` • accepted by ${dispatch.acceptedBy}` : ""}
                      {dispatch.totalCost ? ` • ₦${Number(dispatch.totalCost).toLocaleString("en-NG")}` : ""}
                    </p>
                    {dispatch.notes && <p className="mt-1 rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600">{dispatch.notes}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge status={dispatch.status === "CLOSED" ? "COMPLETED" : dispatch.status === "RETURNED" ? "SUBMITTED" : "IN_PROGRESS"} />
                    {dispatch.status !== "CLOSED" && <Btn variant="secondary" onClick={() => {
                      setReturning(dispatch);
                      setReturnForm({
                        quantityReturned: String(dispatch.quantityReturned || ""), quantityAccepted: String(dispatch.quantityAccepted || ""),
                        quantityRejected: String(dispatch.quantityRejected || ""), quantityShort: String(dispatch.quantityShort || ""), notes: dispatch.notes ?? "",
                      });
                    }}>Record what came back</Btn>}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 text-center text-xs sm:grid-cols-5">
                  {[
                    { label: "Sent", value: dispatch.quantitySent, tone: "text-slate-900" },
                    { label: "Returned", value: dispatch.quantityReturned, tone: "text-slate-900" },
                    { label: "Accepted", value: dispatch.quantityAccepted, tone: "text-emerald-700" },
                    { label: "Rejected / damaged", value: dispatch.quantityRejected, tone: "text-red-700" },
                    { label: "Never came back", value: dispatch.quantityShort, tone: "text-amber-700" },
                  ].map((figure) => (
                    <div key={figure.label}><span className="block text-slate-500">{figure.label}</span><strong className={`text-sm ${figure.tone}`}>{figure.value}</strong></div>
                  ))}
                </div>
                {dispatch.status !== "CLOSED" && outstanding(dispatch) > 0 && (
                  <p className="mt-2 text-[11px] font-semibold text-amber-700">
                    {outstanding(dispatch)} garment(s) are still unaccounted for. Nothing moves to the next stage until every one is accepted, rejected or recorded as short.
                  </p>
                )}
              </Card>
            ))}
      </div>
    ) : (
      <div className="space-y-4">
        <Card className="p-4">
          <p className="text-sm font-bold text-slate-900">Record a bought-in finished garment</p>
          <p className="mt-0.5 text-xs text-slate-500">Stages on a route whose method is Ready-made purchase. This is a purchase with its own cost - never tailor labour, and never outsourced production.</p>
          {buyable.length === 0
            ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">No open stage is a ready-made purchase. Put one first on a route under <Link href="/production/routes" className="font-semibold underline">Production routes</Link>.</p>
            : <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {buyable.map((job) => (
                  <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-800">{job.variant}</p>
                      <p className="text-[11px] text-slate-500">{job.orderNumber} • {job.batchNumber}</p>
                      <p className="mt-0.5 text-[11px] text-slate-600">Route expects {job.quantityReceived} finished garment(s)</p>
                    </div>
                    <Btn variant="secondary" onClick={() => { setBuying(job); setBuyForm({ materialId: String(finishedGarments[0]?.id ?? ""), quantity: String(job.quantityRemaining || job.quantityReceived || ""), unitCost: "", supplier: "", notes: "" }); }}>
                      <Package className="h-3.5 w-3.5" /> Record purchase
                    </Btn>
                  </div>
                ))}
              </div>}
          {finishedGarments.length === 0 && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              No finished garment is in the catalogue yet. Add one under <Link href="/materials" className="font-semibold underline">Materials</Link> with the category
              category Ready-made garment, because a purchase has to name what was bought.
            </p>
          )}
        </Card>

        {receipts.length === 0
          ? <Card><EmptyState title="No finished garments bought in yet" hint="A ready-made receipt stays in the purchase records with its own cost, linked to the exact variant and the route stage it satisfies." /></Card>
          : receipts.map((receipt) => (
              <Card key={receipt.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900">{receipt.garment}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{receipt.variant} • {receipt.orderNumber} • batch {receipt.batchNumber} • bought {fmtDate(receipt.purchaseDate)}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {receipt.supplier ?? "Supplier not recorded"} • ₦{Number(receipt.totalCost).toLocaleString("en-NG")}
                      {receipt.category ? ` • recorded as ${receipt.category}` : ""}
                    </p>
                    {receipt.notes && <p className="mt-1 rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600">{receipt.notes}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {receipt.stageStatus && <Badge status={receipt.stageStatus} />}
                    <Btn variant="secondary" onClick={() => { setJudging(receipt); setJudgeForm({ quantityAccepted: String(receipt.quantity), quantityRejected: "0", notes: "" }); }}>Accept on arrival</Btn>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">{receipt.quantity} bought against the {receipt.stage ? receipt.stage.replaceAll("_", " ") : "—"} stage. Only what is accepted here moves on.</p>
              </Card>
            ))}
      </div>
    )}

    {/* ---- send work out ---- */}
    <Modal open={!!sending} onClose={() => setSending(null)} title={sending ? `Send out - ${sending.variant}` : ""}>
      {sending && <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        const ok = await post("/api/external-work", {
          operationId: sending.id, vendorName: sendForm.vendorName.trim(),
          quantitySent: Number(sendForm.quantitySent), unitCost: sendForm.unitCost === "" ? null : Number(sendForm.unitCost),
          notes: sendForm.notes.trim() || null,
        }, "POST", "Dispatch recorded. Nothing counts as produced until it comes back and is accepted.");
        if (ok) setSending(null);
      }}>
        <p className="text-xs text-slate-500">{sending.orderNumber} • batch {sending.batchNumber} • {methodLabel(sending.method)} • {sending.quantityRemaining} outstanding</p>
        <Field label="Who is doing the work *"><input className={inputCls} required value={sendForm.vendorName} onChange={(event) => setSendForm({ ...sendForm, vendorName: event.target.value })} placeholder="e.g. Lagos Embroidery Ltd" /></Field>
        <Field label="Garments going out *"><input className={inputCls} type="number" min="1" max={sending.quantityRemaining} step="1" required value={sendForm.quantitySent} onChange={(event) => setSendForm({ ...sendForm, quantitySent: event.target.value })} /></Field>
        <Field label="Agreed cost per garment (₦)"><input className={inputCls} type="number" min="0" step="1" value={sendForm.unitCost} onChange={(event) => setSendForm({ ...sendForm, unitCost: event.target.value })} /></Field>
        <Field label="Notes"><textarea className={inputCls} rows={2} value={sendForm.notes} onChange={(event) => setSendForm({ ...sendForm, notes: event.target.value })} /></Field>
        <p className="rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">Sending work out is recorded on the audit trail but moves no quantity: the stage is not further along just because garments left the building.</p>
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setSending(null)}>Cancel</Btn><Btn type="submit" disabled={busy}>{busy ? "Saving…" : "Record dispatch"}</Btn></div>
      </form>}
    </Modal>

    {/* ---- record what came back ---- */}
    <Modal open={!!returning} onClose={() => setReturning(null)} title={returning ? `Return - ${returning.vendorName}` : ""} wide>
      {returning && <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        const ok = await post("/api/external-work", {
          id: returning.id,
          quantityReturned: Number(returnForm.quantityReturned || 0), quantityAccepted: Number(returnForm.quantityAccepted || 0),
          quantityRejected: Number(returnForm.quantityRejected || 0), quantityShort: Number(returnForm.quantityShort || 0),
          notes: returnForm.notes.trim() || null,
        }, "PUT", "Return recorded. Only the accepted garments moved on to the next stage.");
        if (ok) setReturning(null);
      }}>
        <p className="text-xs text-slate-500">{returning.variant} • {returning.orderNumber} • {returning.quantitySent} sent</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Came back *"><input className={inputCls} type="number" min="0" max={returning.quantitySent} step="1" required value={returnForm.quantityReturned} onChange={(event) => setReturnForm({ ...returnForm, quantityReturned: event.target.value })} /></Field>
          <Field label="Accepted as good *"><input className={inputCls} type="number" min="0" step="1" required value={returnForm.quantityAccepted} onChange={(event) => setReturnForm({ ...returnForm, quantityAccepted: event.target.value })} /></Field>
          <Field label="Rejected / damaged"><input className={inputCls} type="number" min="0" step="1" value={returnForm.quantityRejected} onChange={(event) => setReturnForm({ ...returnForm, quantityRejected: event.target.value })} /></Field>
          <Field label="Never came back (short)"><input className={inputCls} type="number" min="0" step="1" value={returnForm.quantityShort} onChange={(event) => setReturnForm({ ...returnForm, quantityShort: event.target.value })} /></Field>
        </div>
        <Field label="Notes"><textarea className={inputCls} rows={2} value={returnForm.notes} onChange={(event) => setReturnForm({ ...returnForm, notes: event.target.value })} placeholder="Required if anything was damaged or did not come back" /></Field>
        <p className="rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">
          Four separate facts: what came back is not what was accepted, and what never arrived is not the same as what arrived
          damaged. Only the <strong>accepted</strong> figure is released to the next stage of the route. A figure already
          recorded cannot be reduced - record a new dispatch instead.
        </p>
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setReturning(null)}>Cancel</Btn><Btn type="submit" disabled={busy}>{busy ? "Saving…" : "Record return"}</Btn></div>
      </form>}
    </Modal>

    {/* ---- record a ready-made purchase ---- */}
    <Modal open={!!buying} onClose={() => setBuying(null)} title={buying ? `Bought in - ${buying.variant}` : ""}>
      {buying && <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        const ok = await post("/api/ready-made", {
          operationId: buying.id, materialId: Number(buyForm.materialId), quantity: Number(buyForm.quantity),
          unitCost: buyForm.unitCost === "" ? null : Number(buyForm.unitCost), supplier: buyForm.supplier.trim() || null,
          notes: buyForm.notes.trim() || null,
        }, "POST", "Purchase recorded. Accept it on arrival before anything moves on.");
        if (ok) setBuying(null);
      }}>
        <p className="text-xs text-slate-500">{buying.orderNumber} • batch {buying.batchNumber} • the route expects {buying.quantityReceived} finished garment(s)</p>
        <Field label="Finished garment bought *">
          <select className={inputCls} required value={buyForm.materialId} onChange={(event) => setBuyForm({ ...buyForm, materialId: event.target.value })}>
            <option value="">Choose the garment</option>
            {materials.map((material) => <option key={material.id} value={material.id}>{material.name}{material.category ? ` (${material.category})` : ""}</option>)}
          </select>
        </Field>
        <Field label="How many bought *"><input className={inputCls} type="number" min="1" max={buying.quantityReceived} step="1" required value={buyForm.quantity} onChange={(event) => setBuyForm({ ...buyForm, quantity: event.target.value })} /></Field>
        <Field label="Cost per garment (₦)"><input className={inputCls} type="number" min="0" step="1" value={buyForm.unitCost} onChange={(event) => setBuyForm({ ...buyForm, unitCost: event.target.value })} /></Field>
        <Field label="Supplier"><input className={inputCls} value={buyForm.supplier} onChange={(event) => setBuyForm({ ...buyForm, supplier: event.target.value })} /></Field>
        <Field label="Notes"><textarea className={inputCls} rows={2} value={buyForm.notes} onChange={(event) => setBuyForm({ ...buyForm, notes: event.target.value })} /></Field>
        <p className="rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">
          This stays in the purchase records with its own cost. It is never counted as tailor labour and never as outsourced
          production, and it pays no worker.
        </p>
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setBuying(null)}>Cancel</Btn><Btn type="submit" disabled={busy}>{busy ? "Saving…" : "Record purchase"}</Btn></div>
      </form>}
    </Modal>

    {/* ---- accept a ready-made delivery ---- */}
    <Modal open={!!judging} onClose={() => setJudging(null)} title={judging ? `Accept on arrival - ${judging.garment}` : ""}>
      {judging && <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        const ok = await post("/api/ready-made", {
          id: judging.id, quantityAccepted: Number(judgeForm.quantityAccepted || 0),
          quantityRejected: Number(judgeForm.quantityRejected || 0), notes: judgeForm.notes.trim() || null,
        }, "PUT", "Acceptance recorded. Only the accepted garments moved on.");
        if (ok) setJudging(null);
      }}>
        <p className="text-xs text-slate-500">{judging.variant} • {judging.orderNumber} • {judging.quantity} bought from {judging.supplier ?? "an unrecorded supplier"}</p>
        <Field label="Accepted as good *"><input className={inputCls} type="number" min="0" max={judging.quantity} step="1" required value={judgeForm.quantityAccepted} onChange={(event) => setJudgeForm({ ...judgeForm, quantityAccepted: event.target.value })} /></Field>
        <Field label="Rejected on arrival"><input className={inputCls} type="number" min="0" max={judging.quantity} step="1" value={judgeForm.quantityRejected} onChange={(event) => setJudgeForm({ ...judgeForm, quantityRejected: event.target.value })} /></Field>
        <Field label="Why (required if any were rejected)"><textarea className={inputCls} rows={2} value={judgeForm.notes} onChange={(event) => setJudgeForm({ ...judgeForm, notes: event.target.value })} placeholder="e.g. Four were navy, not cream" /></Field>
        <p className="rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">A receipt is judged once. Its acceptance is on the audit trail and cannot be re-judged later.</p>
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setJudging(null)}>Cancel</Btn><Btn type="submit" disabled={busy}>{busy ? "Saving…" : "Record acceptance"}</Btn></div>
      </form>}
    </Modal>
  </div>;
}
