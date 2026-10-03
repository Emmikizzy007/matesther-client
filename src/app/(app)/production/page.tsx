"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search, ClipboardCheck } from "lucide-react";
import { Card, PageHeader, Badge, Loading, Modal, Field, inputCls, Btn } from "@/components/ui";
import { fmtDate, methodLabel, stageLabel, STAGES, STAGE_ROLES, personHoldsRole } from "@/lib/format";

// Was a sixth hand-typed copy of the stage -> role map. Now the shared one from
// lib/format, so the board's worker dropdowns and the server's assignment gate can
// never disagree about which role a stage needs.
const STAGE_SPECIALTIES = STAGE_ROLES;
const COLS = ["PENDING", "IN_PROGRESS", "SUBMITTED", "COMPLETED", "ON_HOLD"];
/** One page of the production board. The server caps a request at 1000. */
const PAGE_SIZE = 200;
const COL_LABEL: Record<string, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In Progress",
  SUBMITTED: "Awaiting Inspection",
  COMPLETED: "Completed",
  ON_HOLD: "On Hold",
};

export default function ProductionPage() {
  const [ops, setOps] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  const [canAssignCutting, setCanAssignCutting] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [stage, setStage] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("stage") || "";
  });
  const [selected, setSelected] = useState<any>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  /**
   * Jobs are paged and filtered SERVER-SIDE.
   *
   * This board used to download every production job in the database - measured
   * at 11 MB and 14,560 rows at a realistic scale - and then filter them in the
   * browser. It now asks for one page at a time, with the stage filter applied by
   * the database, and reads the unpaginated total from X-Total-Count so the
   * "showing N of M" line needs no second request.
   */
  async function loadJobs(append: boolean) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: append ? String(ops.length) : "0" });
    if (stage) params.set("stage", stage);
    const response = await fetch(`/api/operations?${params.toString()}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data)) throw new Error(data?.error || "Unable to load production.");
    setTotal(Number(response.headers.get("X-Total-Count") ?? data.length));
    setOps((current) => (append ? [...current, ...data] : data));
  }

  async function loadContext() {
    const [people, access] = await Promise.all([
      fetch("/api/workers?view=slim", { cache: "no-store" }),
      fetch("/api/production-access", { cache: "no-store" }),
    ]);
    const [w, rights] = await Promise.all([people.json(), access.json()]);
    if (!people.ok || !access.ok) throw new Error(w.error || rights.error || "Unable to load production.");
    setWorkers(Array.isArray(w) ? w : []);
    setCanAssignCutting(rights.canAssignCutting === true);
  }

  function load() {
    setLoading(true);
    Promise.all([loadJobs(false), loadContext()])
      .catch((cause) => setErr(cause instanceof Error ? cause.message : "Unable to load production."))
      .finally(() => setLoading(false));
  }
  // Changing the stage filter re-queries the database rather than re-filtering a
  // download of everything.
  useEffect(load, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  function loadMore() {
    setErr("");
    loadJobs(true).catch((cause) => setErr(cause instanceof Error ? cause.message : "Unable to load more jobs."));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      // Only the fields this modal may actually change. It used to post the whole
      // job object back, quantities included - which is how a quantity could be
      // edited by accident as well as on purpose.
      const res = await fetch("/api/operations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selected.id,
          workerId: selected.workerId ?? null,
          pieceRate: selected.pieceRate,
          status: selected.status,
          expectedCompletionDate: selected.expectedCompletionDate || null,
          notes: selected.notes ?? "",
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to save");
      setSelected(null);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  const filtered = ops.filter(
    (o) =>
      (!stage || o.stage === stage) &&
      (!q ||
        o.orderNumber.toLowerCase().includes(q.toLowerCase()) ||
        o.customer.toLowerCase().includes(q.toLowerCase()) ||
        (o.workerName || "").toLowerCase().includes(q.toLowerCase()) ||
        o.batchNumber.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <div>
      <PageHeader
        title="Active Production"
        subtitle="Every production job by stage. Workers submit finished pieces; only inspected and approved pieces move to the next stage."
      />
      {notice && <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{notice}</div>}
      <Card className="mb-4 p-3 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order, school, worker, batch…" className={`${inputCls} pl-9`} />
        </div>
        <select value={stage} onChange={(e) => setStage(e.target.value)} className={`${inputCls} w-auto`}>
          <option value="">All stages</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>{stageLabel(s)}</option>
          ))}
        </select>
        <Link href="/production/inspection" className="inline-flex items-center gap-1.5 bg-violet-700 hover:bg-violet-800 text-white px-4 py-2 rounded-lg text-sm font-medium">
          <ClipboardCheck className="w-4 h-4" /> Inspection Queue
        </Link>
      </Card>

      {!loading && total > ops.length && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-3">
          <p className="text-xs text-slate-600">
            Showing <strong>{ops.length}</strong> of <strong>{total}</strong> production jobs
            {stage ? ` at ${stageLabel(stage)}` : ""}.
          </p>
          <Btn variant="secondary" onClick={loadMore}>Load {Math.min(PAGE_SIZE, total - ops.length)} more</Btn>
        </Card>
      )}
      {!loading && total <= ops.length && total > 0 && (
        <p className="mb-4 text-xs text-slate-500">
          Showing all <strong>{total}</strong> production jobs{stage ? ` at ${stageLabel(stage)}` : ""}.
        </p>
      )}

      {loading ? (
        <Card><Loading /></Card>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-5 gap-3">
          {COLS.map((col) => {
            const items = filtered.filter((o) => o.status === col);
            return (
              <div key={col} className="bg-slate-200/60 rounded-xl p-3 min-h-[300px]">
                <div className="flex items-center justify-between px-1 pb-2">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">
                    {COL_LABEL[col]}
                  </p>
                  <span className="text-xs font-bold bg-white rounded-full px-2 py-0.5 text-slate-600">
                    {items.length}
                  </span>
                </div>
                <div className="space-y-2.5 max-h-[70vh] overflow-y-auto slim-scroll pr-0.5">
                  {items.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => {
                        setErr("");
                        if (o.stage === "CUTTING" && !canAssignCutting) {
                          setNotice("Cutting jobs are view-only for cutter-supervisors. The Owner or a non-cutting supervisor assigns Cutters. Submit your own finished Cutting work from My Jobs.");
                          return;
                        }
                        setNotice("");
                        setSelected({ ...o });
                      }}
                      className={`w-full rounded-lg border bg-white p-3 text-left shadow-sm transition-colors ${o.stage === "CUTTING" && !canAssignCutting ? "border-amber-200" : "border-slate-200 hover:border-matesther-600"}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-matesther-800">
                          {stageLabel(o.stage)}
                        </span>
                        <span className="text-[11px] text-slate-400">{o.batchNumber}</span>
                      </div>
                      <p className="text-sm font-semibold mt-1 text-matesther-800">{o.orderNumber}</p>
                      <p className="text-xs text-slate-500 truncate">{o.customer}</p>
                      {/* The EXACT garment, and this stage's place in THIS batch's
                          route - so a polo on a three-stage route is never read as
                          "stuck" at a stage it does not have. */}
                      <p className="mt-1 text-[11px] font-semibold text-slate-700">{o.garment} • {o.variant}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
                        {o.routePosition && o.routeLength ? <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-600">Stage {o.routePosition} of {o.routeLength}</span> : null}
                        {o.method && o.method !== "INTERNAL" ? <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">{methodLabel(o.method)}</span> : null}
                      </p>
                      <p className="text-xs mt-1.5">
                        <span className="text-slate-500">Worker: </span>
                        <span className="font-medium">{o.workerName || <span className="text-amber-600">Unassigned</span>}</span>
                      </p>
                      {o.pieceRate !== null && <p className="mt-0.5 text-[11px] font-semibold text-matesther-700">Agreed pay: ₦{Number(o.pieceRate).toLocaleString("en-NG")} per piece</p>}
                      <div className="flex flex-wrap gap-1 mt-2 text-[10px]">
                        <span className="bg-slate-100 rounded px-1.5 py-0.5">Rcvd {o.quantityReceived}</span>
                        <span className="bg-violet-50 text-violet-800 rounded px-1.5 py-0.5 font-semibold">Subm {o.quantityCompleted}</span>
                        <span className="bg-matesther-50 text-matesther-800 rounded px-1.5 py-0.5 font-semibold">Appr {o.quantityApproved}</span>
                        {o.quantityRework > 0 && <span className="bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 font-semibold">Rework {o.quantityRework}</span>}
                        {o.quantityRejected > 0 && <span className="bg-red-50 text-red-700 rounded px-1.5 py-0.5 font-semibold">Rej {o.quantityRejected}</span>}
                      </div>
                      {o.pendingInspection > 0 && (
                        <p className="text-[11px] text-violet-700 font-bold mt-1.5">
                          {o.pendingInspection} pcs awaiting inspection →
                        </p>
                      )}
                      <p className="text-[11px] text-slate-500 mt-1.5">
                        Due {fmtDate(o.expectedCompletionDate)} • Order due {fmtDate(o.dueDate)}
                      </p>
                      {o.stage === "CUTTING" && !canAssignCutting && <p className="mt-1.5 text-[11px] font-semibold text-amber-800">View only • Owner assigns Cutters</p>}
                    </button>
                  ))}
                  {items.length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-6">No cards</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? `${stageLabel(selected.stage)} - ${selected.batchNumber}` : ""}>
        {selected && (
          <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
            <p className="sm:col-span-2 text-xs text-slate-500">
              {selected.orderNumber} • {selected.customer} • {selected.garment}{selected.size ? ` • Size ${selected.size}` : ""}{selected.color ? ` • ${selected.color}` : ""} • Batch qty {selected.batchQuantity}
            </p>
            <Field label="Status">
              <select value={selected.status} onChange={(e) => setSelected({ ...selected, status: e.target.value })} className={inputCls}>
                <option value="PENDING">Pending</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="SUBMITTED">Submitted for inspection</option>
                <option value="COMPLETED">Completed (requires approved inspection)</option>
                <option value="ON_HOLD">On Hold</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </Field>
            <Field label="Worker">
              <select value={selected.workerId || ""} onChange={(e) => setSelected({ ...selected, workerId: e.target.value ? Number(e.target.value) : null, pieceRate: null })} className={inputCls}>
                <option value="">Unassigned</option>
                {workers.filter((w) => w.status === "ACTIVE" && (!STAGE_SPECIALTIES[selected.stage] || personHoldsRole(w, STAGE_SPECIALTIES[selected.stage]))).map((w) => <option key={w.id} value={w.id}>{w.name} - {STAGE_SPECIALTIES[selected.stage] ?? w.specialty}</option>)}
              </select>
            </Field>
            {workers.find((w) => w.id === Number(selected.workerId))?.paymentType === "PER_PIECE" && <Field label="Agreed pay per approved garment (₦) *">
              <input type="number" min="1" step="1" required={selected.quantityCompleted === 0 && selected.pieceRate === null}
                disabled={selected.quantityCompleted > 0 || selected.quantityInspected > 0} value={selected.pieceRate ?? ""}
                onChange={(e) => setSelected({ ...selected, pieceRate: e.target.value === "" ? null : Number(e.target.value) })} className={inputCls} />
            </Field>}
            {/* Quantities are DERIVED, so they are shown, not typed. Each one is
                the sum of the events that produced it: what the batch allocated,
                what the worker submitted, what an inspection approved. */}
            <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-2">Quantities - derived from the production trail</p>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span className="bg-white border border-slate-200 rounded px-2 py-0.5">Received <strong>{selected.quantityReceived ?? 0}</strong></span>
                <span className="bg-white border border-slate-200 rounded px-2 py-0.5">Submitted <strong>{selected.quantityCompleted ?? 0}</strong></span>
                <span className="bg-white border border-emerald-200 rounded px-2 py-0.5">Approved <strong className="text-emerald-700">{selected.quantityApproved ?? 0}</strong></span>
                <span className="bg-white border border-slate-200 rounded px-2 py-0.5">Rework <strong>{selected.quantityRework ?? 0}</strong></span>
                <span className="bg-white border border-red-200 rounded px-2 py-0.5">Rejected <strong className="text-red-700">{selected.quantityRejected ?? 0}</strong></span>
                <span className="bg-white border border-slate-200 rounded px-2 py-0.5">Outstanding <strong>{selected.quantityRemaining ?? 0}</strong></span>
                <span className="bg-white border border-violet-200 rounded px-2 py-0.5">Awaiting inspection <strong className="text-violet-700">{selected.pendingInspection ?? 0}</strong></span>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                These cannot be typed over. A stage receives only what the stage before it approved, and work only becomes
                inspectable when the assigned worker submits it. If a genuine mis-count needs fixing, the Owner records a
                correction, which keeps who changed it, when and why.
              </p>
            </div>
            <Field label="Expected completion"><input type="date" value={selected.expectedCompletionDate || ""} onChange={(e) => setSelected({ ...selected, expectedCompletionDate: e.target.value })} className={inputCls} /></Field>
            <Field label="Notes" className="sm:col-span-2">
              <textarea value={selected.notes || ""} onChange={(e) => setSelected({ ...selected, notes: e.target.value })} className={inputCls} rows={2} />
            </Field>
            <p className="sm:col-span-2 text-[11px] text-slate-500">
              Quality gate: a stage can only be completed after the Project Manager or Owner inspects and approves the submitted pieces - use the Inspection Queue for that.
            </p>
            {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
            <div className="sm:col-span-2 flex justify-end gap-2">
              <Btn variant="secondary" onClick={() => setSelected(null)}>Cancel</Btn>
              <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Update"}</Btn>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
