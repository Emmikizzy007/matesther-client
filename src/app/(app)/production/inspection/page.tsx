"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, ClipboardCheck, RefreshCcw, Search, XCircle } from "lucide-react";
import { Badge, Btn, Card, EmptyState, Field, inputCls, Loading, Modal, PageHeader } from "@/components/ui";
import { fmtDate, stageLabel, personHoldsRole, personRoles } from "@/lib/format";
import { useAuth } from "@/lib/auth";

type QueueJob = { id: number; orderId: number | null; orderNumber: string; customer: string; stage: string;
  garment: string | null; size: string | null; color: string | null; batchNumber: string; workerName: string | null; workerId: number | null;
  pendingInspection: number; expectedCompletionDate: string | null; quantityCompleted: number; quantityApproved: number };
type Inspection = { id: number; orderId: number | null; orderNumber: string; customer: string; stage: string;
  batchNumber: string; inspectedBy: string; inspectedAt: string | null; quantityApproved: number;
  quantityRework: number; quantityRejected: number; notes: string | null };
type QueueData = { inspection: { awaiting: QueueJob[]; recentApproved: Inspection[]; reworkRequired: Inspection[] } };
type Tab = "awaiting" | "recent" | "rework";
const emptySplit = { approved: "0", rework: "0", rejected: "0", notes: "" };

function schoolGroups<T extends { orderId: number | null; customer: string; orderNumber: string }>(rows: T[]) {
  const groups = new Map<string, { key: string; customer: string; orderNumber: string; orderId: number | null; rows: T[] }>();
  for (const row of rows) {
    const key = row.orderId ? String(row.orderId) : `${row.customer}-${row.orderNumber}`;
    const group = groups.get(key) ?? { key, customer: row.customer, orderNumber: row.orderNumber, orderId: row.orderId, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export default function InspectionQueuePage() {
  const { user } = useAuth();
  const [data, setData] = useState<QueueData | null>(null);
  const [inspectors, setInspectors] = useState<{ id: number; name: string; specialty: string; roles?: string[] }[]>([]);
  const [ownWorkerId, setOwnWorkerId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("awaiting");
  const [search, setSearch] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [selected, setSelected] = useState<QueueJob | null>(null);
  const [split, setSplit] = useState(emptySplit);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  async function load(openRequested = false) {
    setError("");
    try {
      const [response, accessResponse] = await Promise.all([
        fetch("/api/dashboard?view=pm", { cache: "no-store" }),
        fetch("/api/production-access", { cache: "no-store" }),
      ]);
      const [result, access] = await Promise.all([response.json(), accessResponse.json()]);
      if (!response.ok || !Array.isArray(result.inspection?.awaiting) || !Array.isArray(result.inspection?.recentApproved) || !Array.isArray(result.inspection?.reworkRequired))
        throw new Error(result.error || "Could not load submitted work.");
      if (!accessResponse.ok) throw new Error(access.error || "Could not verify inspector permissions.");
      setOwnWorkerId(typeof access.workerId === "number" ? access.workerId : null);
      setData(result);
      setOpenGroup((current) => current ?? (result.inspection.awaiting[0]?.orderId ? String(result.inspection.awaiting[0].orderId) : null));
      if (openRequested) {
        const requestedId = new URLSearchParams(window.location.search).get("op");
        const found = result.inspection.awaiting.find((job: QueueJob) => String(job.id) === requestedId);
        if (found) {
          if (user?.role === "PRODUCTION_MANAGER" && typeof access.workerId === "number" && found.workerId === access.workerId)
            setNotice("You cannot inspect your own production work. Ask the Owner or a different supervisor to inspect this job.");
          else inspect(found);
        }
      }
      // Workers list is optional supporting context; it must not block the queue.
      fetch("/api/workers", { cache: "no-store" })
        .then((res) => res.ok ? res.json() : [])
        .then((rows) => setInspectors(Array.isArray(rows) ? rows.filter((person) => person.status === "ACTIVE" && (person.isInspector || personHoldsRole(person, "Inspection Officer"))) : []))
        .catch(() => setInspectors([]));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the Inspection Queue."); }
  }
  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function inspect(job: QueueJob) {
    if (user?.role === "PRODUCTION_MANAGER" && ownWorkerId !== null && job.workerId === ownWorkerId) {
      setNotice("You cannot inspect your own production work. Ask the Owner or a different supervisor to inspect this job.");
      return;
    }
    setSelected(job);
    setSplit({ approved: String(job.pendingInspection), rework: "0", rejected: "0", notes: "" });
    setFormError("");
  }
  function changeOutcome(field: "rework" | "rejected", raw: string) {
    setSplit((current) => {
      const rework = field === "rework" ? Number(raw) || 0 : Number(current.rework) || 0;
      const rejected = field === "rejected" ? Number(raw) || 0 : Number(current.rejected) || 0;
      return { ...current, [field]: raw, approved: String(Math.max(0, (selected?.pendingInspection ?? 0) - rework - rejected)) };
    });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || saving) return;
    const approved = Number(split.approved), rework = Number(split.rework), rejected = Number(split.rejected);
    const total = approved + rework + rejected;
    if (![approved, rework, rejected].every((value) => Number.isSafeInteger(value) && value >= 0) || total < 1 || total > selected.pendingInspection)
      return setFormError(`Choose 1 to ${selected.pendingInspection} whole garments in total.`);
    if ((rework || rejected) && !split.notes.trim()) return setFormError("Describe what needs rework or why garments were rejected.");
    setSaving(true); setFormError(""); setNotice("");
    try {
      const response = await fetch("/api/inspections", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: selected.id, quantityApproved: approved,
          quantityRework: rework, quantityRejected: rejected, notes: split.notes.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not record this inspection.");
      setSelected(null);
      setNotice(`${approved} approved${rework ? `, ${rework} sent for rework` : ""}${rejected ? `, ${rejected} rejected` : ""}. Only approved garments move to the next stage.`);
      await load();
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : "Could not record this inspection."); }
    finally { setSaving(false); }
  }

  if (error) return <Card className="p-6"><h1 className="font-semibold text-red-700">Could not open Inspection Queue</h1><p className="mt-1 text-sm text-slate-600">{error}</p><Btn className="mt-4" onClick={() => void load()}>Try again</Btn></Card>;
  if (!data) return <Card><Loading label="Loading submitted work..." /></Card>;

  const awaiting = data.inspection.awaiting;
  const rows = tab === "awaiting" ? awaiting : tab === "recent" ? data.inspection.recentApproved : data.inspection.reworkRequired;
  const term = search.trim().toLowerCase();
  const groups = schoolGroups(rows.filter((row) => !term || `${row.customer} ${row.orderNumber} ${row.stage} ${"garment" in row ? row.garment : ""}`.toLowerCase().includes(term)));
  const approved = Number(split.approved) || 0, rework = Number(split.rework) || 0, rejected = Number(split.rejected) || 0;
  const uninspected = (selected?.pendingInspection ?? 0) - approved - rework - rejected;

  return <div className="mx-auto max-w-5xl">
    <PageHeader title="Inspection Queue" subtitle="Select a school, inspect submitted garments, then record what passed or needs correction." />
    {notice && <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800"><CheckCircle2 className="mr-2 inline h-4 w-4" />{notice}</div>}
    <div className="mb-4 grid grid-cols-3 gap-2">
      {([{ key: "awaiting", title: "To inspect", count: awaiting.length },
        { key: "recent", title: "Recent", count: data.inspection.recentApproved.length },
        { key: "rework", title: "Rework", count: data.inspection.reworkRequired.length }] as const).map((item) =>
        <button key={item.key} type="button" onClick={() => { setTab(item.key); setOpenGroup(null); }}
          aria-pressed={tab === item.key}
          className={`min-h-14 rounded-xl border px-2 py-3 text-center text-xs font-semibold sm:text-sm ${tab === item.key ? "border-matesther-800 bg-matesther-800 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-matesther-500"}`}>
          {item.title} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${tab === item.key ? "bg-white/20" : "bg-slate-100"}`}>{item.count}</span>
        </button>)}
    </div>
    <div className="relative mb-4"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input className={`${inputCls} pl-9`} value={search} onChange={(event) => { setSearch(event.target.value); setOpenGroup(null); }} placeholder="Find a school, order or stage" aria-label="Search inspection queue" />
    </div>
    {tab === "awaiting" && <p className="mb-4 text-sm text-slate-600"><strong>{awaiting.reduce((sum, job) => sum + job.pendingInspection, 0)} garments</strong> across {schoolGroups(awaiting).length} school order{schoolGroups(awaiting).length === 1 ? "" : "s"} are waiting. Open a school to see its jobs.</p>}
    {groups.length === 0 ? <Card><EmptyState title={tab === "awaiting" ? "No work awaiting inspection" : tab === "recent" ? "No recent inspections" : "No rework requested"} hint={search ? "Try a different search." : "Production records will appear here when available."} /></Card> :
      <div className="space-y-3">{groups.map((group) => {
        const expanded = openGroup === group.key || (openGroup === null && groups.length === 1);
        const pieces = tab === "awaiting" ? (group.rows as QueueJob[]).reduce((sum, job) => sum + job.pendingInspection, 0) : null;
        return <Card key={`${tab}-${group.key}`} className="overflow-hidden">
          <button type="button" aria-expanded={expanded} onClick={() => setOpenGroup(expanded ? "" : group.key)} className="flex min-h-[74px] w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5">
            <div className="min-w-0"><p className="truncate font-semibold text-matesther-900">{group.customer}</p><p className="mt-0.5 text-xs text-slate-500">{group.orderNumber} <span className="mx-1">•</span> {group.rows.length} {tab === "awaiting" ? "job" : "record"}{group.rows.length === 1 ? "" : "s"}{pieces !== null ? ` • ${pieces} garments` : ""}</p></div>
            <ChevronDown className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
          {expanded && <div className="divide-y divide-slate-100 border-t border-slate-100">
            {tab === "awaiting" ? (group.rows as QueueJob[]).map((job) => <div key={job.id} className="px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-bold text-slate-900">{stageLabel(job.stage)}</h3><Badge status="SUBMITTED" /></div>
                  <p className="mt-1 text-sm text-slate-700">{job.garment || "Uniform"}{job.size ? ` • Size ${job.size}` : ""}{job.color ? ` • ${job.color}` : ""}</p>
                  <p className="mt-1 text-xs text-slate-500">{job.batchNumber} • {job.workerName || "Unassigned"}{job.expectedCompletionDate ? ` • Expected ${fmtDate(job.expectedCompletionDate)}` : ""}</p></div>
                <div className="text-right"><p className="text-xl font-extrabold text-violet-700">{job.pendingInspection}</p><p className="text-[11px] text-slate-500">pieces to check</p></div>
              </div>
              {user?.role === "PRODUCTION_MANAGER" && ownWorkerId !== null && job.workerId === ownWorkerId
                ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-900">Your work: the Owner or a different supervisor must inspect it.</p>
                : <button type="button" onClick={() => inspect(job)} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-matesther-800 px-4 text-sm font-bold text-white hover:bg-matesther-900 sm:w-auto"><ClipboardCheck className="h-4 w-4" /> Inspect this job</button>}
            </div>) : (group.rows as Inspection[]).map((record) => <div key={record.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-slate-900">{stageLabel(record.stage)} <span className="font-normal text-slate-500">• {record.batchNumber}</span></p><span className="text-xs text-slate-500">{fmtDate(record.inspectedAt)}</span></div>
              <p className="mt-1 flex flex-wrap gap-2 text-xs"><span className="font-semibold text-emerald-700"><CheckCircle2 className="mr-0.5 inline h-3 w-3" />{record.quantityApproved} approved</span>{record.quantityRework > 0 && <span className="font-semibold text-amber-700"><RefreshCcw className="mr-0.5 inline h-3 w-3" />{record.quantityRework} rework</span>}{record.quantityRejected > 0 && <span className="font-semibold text-red-700"><XCircle className="mr-0.5 inline h-3 w-3" />{record.quantityRejected} rejected</span>}</p>
              <p className="mt-1 text-xs text-slate-500">Inspected by {record.inspectedBy}{record.notes ? ` • ${record.notes}` : ""}</p>
            </div>)}
            {tab === "awaiting" && user?.role === "OWNER" && group.orderId && <div className="px-4 py-3 sm:px-5"><Link href={`/orders/${group.orderId}`} className="text-xs font-semibold text-matesther-700 hover:underline">Open full order →</Link></div>}
          </div>}
        </Card>;
      })}</div>}
    {tab !== "awaiting" && <Link href="/production/history" className="mt-4 inline-block text-sm font-semibold text-matesther-700 hover:underline">View full production history →</Link>}
    {inspectors.length > 0 && <details className="mt-5 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600"><summary className="cursor-pointer font-semibold text-slate-700">Inspectors on duty</summary><p className="mt-2">{inspectors.map((person) => `${person.name} (${personRoles(person).join(", ")})`).join(" • ")}</p></details>}

    <Modal open={!!selected} onClose={() => { if (!saving) setSelected(null); }} title="Check submitted garments">
      {selected && <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg border border-matesther-100 bg-matesther-50 p-4">
          <p className="text-xs font-semibold uppercase text-matesther-700">{selected.customer} • {selected.orderNumber}</p>
          <p className="mt-1 font-bold text-slate-900">{stageLabel(selected.stage)} • {selected.garment || "Uniform"}</p>
          <p className="mt-1 text-xs text-slate-600">{selected.batchNumber}{selected.size ? ` • Size ${selected.size}` : ""}{selected.color ? ` • ${selected.color}` : ""} • Worker: {selected.workerName || "Unassigned"}</p>
          <p className="mt-2 text-sm font-semibold text-matesther-800">{selected.pendingInspection} garments handed in for inspection</p>
        </div>
        <div className="space-y-3">
          <Field label="Approved (move to next stage)"><input className={`${inputCls} min-h-12 text-base`} type="number" inputMode="numeric" min="0" max={selected.pendingInspection} step="1" required value={split.approved} onChange={(event) => setSplit({ ...split, approved: event.target.value })} /></Field>
          <Field label="Rework (return to worker)"><input className={`${inputCls} min-h-12 text-base`} type="number" inputMode="numeric" min="0" max={selected.pendingInspection} step="1" required value={split.rework} onChange={(event) => changeOutcome("rework", event.target.value)} /></Field>
          <Field label="Rejected (do not move forward)"><input className={`${inputCls} min-h-12 text-base`} type="number" inputMode="numeric" min="0" max={selected.pendingInspection} step="1" required value={split.rejected} onChange={(event) => changeOutcome("rejected", event.target.value)} /></Field>
        </div>
        <div className={`rounded-lg p-3 text-sm ${uninspected < 0 ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-700"}`}><strong>{approved + rework + rejected}</strong> of <strong>{selected.pendingInspection}</strong> accounted for. {uninspected > 0 ? `${uninspected} remain in the queue.` : uninspected < 0 ? "Too many garments. Adjust the quantities." : "All submitted garments accounted for."}</div>
        <Field label={rework || rejected ? "Reason / inspection notes *" : "Inspection notes (optional)"}><textarea className={inputCls} rows={2} required={!!(rework || rejected)} value={split.notes} onChange={(event) => setSplit({ ...split, notes: event.target.value })} placeholder={rework || rejected ? "Explain what needs correction" : "Any observations"} /></Field>
        <p className="text-xs text-slate-500">Inspected by {user?.name || "signed-in supervisor"}. This result is kept in production history.</p>
        {formError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{formError}</p>}
        <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:justify-end"><Btn variant="secondary" onClick={() => setSplit({ approved: String(selected.pendingInspection), rework: "0", rejected: "0", notes: "" })}>Approve all</Btn><Btn variant="secondary" onClick={() => setSelected(null)} disabled={saving}>Cancel</Btn><Btn type="submit" disabled={saving || uninspected < 0 || approved + rework + rejected < 1}>{saving ? "Saving..." : "Save inspection"}</Btn></div>
      </form>}
    </Modal>
  </div>;
}
