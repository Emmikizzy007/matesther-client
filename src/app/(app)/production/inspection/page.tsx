"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardCheck, CheckCircle2, RefreshCcw, XCircle } from "lucide-react";
import { Card, CardHeader, PageHeader, Badge, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { fmtDate, stageLabel } from "@/lib/format";
import { useAuth } from "@/lib/auth";

export default function InspectionQueuePage() {
  const { user } = useAuth();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [form, setForm] = useState({ quantityApproved: "", quantityRework: "", quantityRejected: "", notes: "" });
  const [formErr, setFormErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [inspectors, setInspectors] = useState<any[]>([]);
  const [inspBy, setInspBy] = useState(user?.name || "");

  async function load(openRequested = false) {
    setErr("");
    try {
      const [response, staffResponse] = await Promise.all([
        fetch("/api/dashboard?view=pm", { cache: "no-store" }),
        fetch("/api/workers", { cache: "no-store" }),
      ]);
      const payload = await response.json();
      if (!response.ok || !payload.inspection?.awaiting || !payload.inspection?.recentApproved || !payload.inspection?.reworkRequired)
        throw new Error(payload.error || "Could not load the Inspection Queue. Please try again.");
      setD(payload);
      if (staffResponse.ok) {
        const people = await staffResponse.json();
        if (Array.isArray(people)) setInspectors(people.filter((person: any) => person.isInspector && person.status === "ACTIVE"));
      }
      if (openRequested) {
        const op = new URLSearchParams(window.location.search).get("op");
        const matchingJob = payload.inspection.awaiting.find((job: any) => String(job.id) === op);
        if (matchingJob) openInspect(matchingJob);
      }
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : "Could not load the Inspection Queue.");
    }
  }
  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function openInspect(o: any) {
    setForm({ quantityApproved: String(o.pendingInspection), quantityRework: "0", quantityRejected: "0", notes: "" });
    setFormErr("");
    setInspBy(user?.name || "");
    setSelected(o);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormErr("");
    try {
      const res = await fetch("/api/inspections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationId: selected.id,
            quantityApproved: Number(form.quantityApproved) || 0,
            quantityRework: Number(form.quantityRework) || 0,
            quantityRejected: Number(form.quantityRejected) || 0,
            notes: form.notes,
            inspectedBy: inspBy || user?.name || "Inspector",
          }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to record inspection");
      setSelected(null);
      load();
    } catch (e: any) {
      setFormErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (err) return (
    <Card className="p-6">
      <p className="font-semibold text-red-700">Could not open Inspection Queue</p>
      <p className="mt-1 text-sm text-slate-600">{err}</p>
      <Btn className="mt-4" onClick={() => void load()}>Try again</Btn>
    </Card>
  );
  if (!d) return <Card><Loading label="Loading inspection queue..." /></Card>;

  return (
    <div>
      <PageHeader
        title="Inspection Queue"
        subtitle="Workers submit finished pieces here. You approve, send to rework or reject - only approved pieces move to the next stage."
      />

      {inspectors.length > 0 && (
        <Card className="mb-4 p-4">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-2">
            Inspectors on duty - Matesther staff who also inspect
          </p>
          <div className="flex flex-wrap gap-2">
            {inspectors.map((w: any) => (
              <span key={w.id} className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800">
                {w.name} <span className="font-normal text-violet-500">• {w.specialty} &amp; Inspector</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card className="mb-4">
        <CardHeader
          title={`Awaiting Inspection (${d.inspection.awaiting.length})`}
          subtitle="Nothing moves forward without your approval"
        />
        <div className="divide-y divide-slate-100">
          {d.inspection.awaiting.map((o: any) => (
            <div key={o.id} className="px-5 py-4 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[240px]">
                <p className="text-sm font-bold">{stageLabel(o.stage)} - {o.batchNumber}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {user?.role === "OWNER"
                    ? <Link href={`/orders/${o.orderId}`} className="text-matesther-700 hover:underline font-semibold">{o.orderNumber}</Link>
                    : <span className="font-semibold text-matesther-700">{o.orderNumber}</span>} • {o.customer}
                </p>
                <p className="text-xs text-slate-500">
                  Worker: <span className="font-medium">{o.workerName || "Unassigned"}</span> • Expected {fmtDate(o.expectedCompletionDate)}
                  {o.notes ? ` • ${o.notes}` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-extrabold text-violet-700">{o.pendingInspection}</p>
                <p className="text-[11px] text-slate-500">pieces to inspect</p>
              </div>
              <Btn variant="gold" onClick={() => openInspect(o)}>
                <ClipboardCheck className="w-4 h-4" /> Inspect
              </Btn>
            </div>
          ))}
          {d.inspection.awaiting.length === 0 && (
            <EmptyState title="Queue is clear" hint="No work is waiting for inspection right now." />
          )}
        </div>
      </Card>

      <div className="grid xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Recently Approved" subtitle="Latest inspection results" />
          <div className="divide-y divide-slate-100">
            {d.inspection.recentApproved.map((i: any) => (
              <div key={i.id} className="px-5 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <p className="font-semibold">{stageLabel(i.stage)} - {i.batchNumber} <span className="font-normal text-slate-500">• {i.orderNumber}</span></p>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  <span className="text-emerald-700 font-semibold">{i.quantityApproved} approved</span>
                  {i.quantityRework > 0 && (
                    <span className="text-amber-700 inline-flex items-center gap-1"> • <RefreshCcw className="w-3 h-3" />{i.quantityRework} rework</span>
                  )}
                  {i.quantityRejected > 0 && (
                    <span className="text-red-600 inline-flex items-center gap-1"> • <XCircle className="w-3 h-3" />{i.quantityRejected} rejected</span>
                  )}
                  {" "}{i.notes ? `• ${i.notes}` : ""}
                  <span className="block mt-0.5">by {i.inspectedBy} • {fmtDate(i.inspectedAt)}</span>
                </p>
              </div>
            ))}
            {d.inspection.recentApproved.length === 0 && <p className="p-5 text-sm text-slate-500">No inspections yet.</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Rework Required" subtitle="Pieces sent back to workers for correction" />
          <div className="divide-y divide-slate-100">
            {d.inspection.reworkRequired.map((i: any) => (
              <div key={i.id} className="px-5 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <RefreshCcw className="w-4 h-4 text-amber-600" />
                  <p className="font-semibold">{stageLabel(i.stage)} - {i.batchNumber} <span className="font-normal text-slate-500">• {i.orderNumber} • {i.customer}</span></p>
                </div>
                <p className="text-xs text-slate-500 mt-1">{i.quantityRework} pcs • {i.notes || "-"} • by {i.inspectedBy} • {fmtDate(i.inspectedAt)}</p>
              </div>
            ))}
            {d.inspection.reworkRequired.length === 0 && <p className="p-5 text-sm text-slate-500">No rework requested. ✓</p>}
          </div>
        </Card>
      </div>

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? `Inspect - ${stageLabel(selected.stage)} (${selected.batchNumber})` : ""}>
        {selected && (
          <form onSubmit={submit} className="grid sm:grid-cols-3 gap-3">
            <p className="sm:col-span-3 text-xs text-slate-500 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2">
              {selected.pendingInspection} piece(s) submitted by {selected.workerName || "worker"} - {selected.orderNumber} ({selected.customer}).
              <span className="font-semibold"> Only approved pieces move to the next stage.</span>
            </p>
            <Field label="Approved ✓"><input type="number" min="0" value={form.quantityApproved} onChange={(e) => setForm({ ...form, quantityApproved: e.target.value })} className={`${inputCls} border-emerald-300`} /></Field>
            <Field label="Rework ↺"><input type="number" min="0" value={form.quantityRework} onChange={(e) => setForm({ ...form, quantityRework: e.target.value })} className={`${inputCls} border-amber-300`} /></Field>
            <Field label="Rejected ✗"><input type="number" min="0" value={form.quantityRejected} onChange={(e) => setForm({ ...form, quantityRejected: e.target.value })} className={`${inputCls} border-red-300`} /></Field>
            <p className="sm:col-span-3 text-xs font-semibold text-slate-600">
              Total: {(Number(form.quantityApproved) || 0) + (Number(form.quantityRework) || 0) + (Number(form.quantityRejected) || 0)} of {selected.pendingInspection}
            </p>
            <Field label="Inspector">
              <select value={inspBy} onChange={(e) => setInspBy(e.target.value)} className={inputCls}>
                <option value={user?.name || ""}>{user?.name || "Me"}</option>
                {inspectors
                  .filter((w: any) => w.name !== user?.name)
                  .map((w: any) => (
                    <option key={w.id} value={w.name}>
                      {w.name} - {w.specialty} &amp; Inspector
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Inspection notes" className="sm:col-span-2">
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputCls} rows={2} placeholder="e.g. 5 sent back for loose side seams" />
            </Field>
            {formErr && <p className="sm:col-span-3 text-sm text-red-600">{formErr}</p>}
            <div className="sm:col-span-3 flex justify-end gap-2">
              <Btn variant="secondary" onClick={() => setSelected(null)}>Cancel</Btn>
              <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record Inspection"}</Btn>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
