"use client";

import { useEffect, useState } from "react";
import { CalendarClock, CheckCircle2, ClipboardCheck, Search } from "lucide-react";
import { Badge, Btn, Card, Loading, PageHeader, inputCls } from "@/components/ui";
import { SchoolOrderGroups } from "@/components/SchoolOrderGroups";
import { fmtDate, fmtDateTime, stageLabel, STAGES } from "@/lib/format";

type Job = {
  id: number; orderId: number | null; orderNumber: string; customer: string;
  batchNumber: string; stage: string; workerName: string | null; garment: string;
  size: string | null; color: string | null; status: string;
  quantityReceived: number; quantityCompleted: number; quantityApproved: number;
  quantityRework: number; quantityRejected: number; quantityRemaining: number;
  assignedAt: string | null; expectedCompletionDate: string | null; completedAt: string | null; notes: string | null;
};
type Inspection = {
  id: number; orderId: number | null; orderNumber: string; customer: string; batchNumber: string;
  stage: string; workerName: string | null; inspectedBy: string;
  inspectedAt: string | null; quantityApproved: number; quantityRework: number;
  quantityRejected: number; notes: string | null;
};
type LedgerFilter = "active" | "completed" | "all";
/** One page of the stage ledger. The server caps a request at 1000. */
const PAGE_SIZE = 200;
const metrics = [
  { field: "quantityReceived", label: "Received" }, { field: "quantityCompleted", label: "Submitted" },
  { field: "quantityApproved", label: "Approved" }, { field: "quantityRework", label: "Rework" },
  { field: "quantityRejected", label: "Rejected" }, { field: "quantityRemaining", label: "Remaining" },
] as const;

export default function ProductionHistoryPage() {
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"ledger" | "inspections">("ledger");
  const [filter, setFilter] = useState<LedgerFilter>("active");
  const [stage, setStage] = useState("");
  const [search, setSearch] = useState("");

  /**
   * Stage filtering and paging happen SERVER-SIDE.
   *
   * This page used to download every production job in the database - measured at
   * 14,593 rows and 11.2 MB - and then filter them in the browser, even though its
   * default view only ever shows active jobs. It now asks for one page of the jobs
   * matching the chosen status and stage, and reads the unpaginated total from
   * X-Total-Count.
   */
  const STATUS_FOR_FILTER: Record<LedgerFilter, string> = {
    active: "PENDING,IN_PROGRESS,SUBMITTED,ON_HOLD",
    completed: "COMPLETED",
    all: "",
  };

  async function loadJobs(append: boolean) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: append ? String(jobs.length) : "0" });
    if (STATUS_FOR_FILTER[filter]) params.set("status", STATUS_FOR_FILTER[filter]);
    if (stage) params.set("stage", stage);
    const response = await fetch(`/api/operations?${params.toString()}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data)) throw new Error(data?.error || "Could not load production history.");
    setTotal(Number(response.headers.get("X-Total-Count") ?? data.length));
    setJobs((current) => (append ? [...current, ...data] : data));
  }

  async function load() {
    setLoading(true); setError("");
    try {
      const [inspectionResponse] = await Promise.all([
        fetch("/api/inspections?limit=500", { cache: "no-store" }),
        loadJobs(false),
      ]);
      const history = await inspectionResponse.json();
      if (!inspectionResponse.ok || !Array.isArray(history))
        throw new Error(history.error || "Could not load production history.");
      setInspections(history);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load production history."); }
    finally { setLoading(false); }
  }
  // Changing the status or stage filter re-queries the database instead of
  // re-filtering a download of everything.
  useEffect(() => { void load(); }, [filter, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  function loadMore() {
    setError("");
    loadJobs(true).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load more stages."));
  }

  const query = search.trim().toLowerCase();
  const included = (job: Job, chosen: LedgerFilter) => chosen === "all" ||
    chosen === "completed" && job.status === "COMPLETED" ||
    chosen === "active" && job.status !== "COMPLETED" && job.status !== "CANCELLED" &&
    (job.quantityReceived > 0 || ["IN_PROGRESS", "SUBMITTED", "ON_HOLD"].includes(job.status));
  // The per-filter counts that used to live here were computed from whatever rows
  // the browser had downloaded, so they silently undercounted as soon as the list
  // was paged. The badge now shows X-Total-Count for the filter actually queried.
  const filteredJobs = jobs.filter((job) => included(job, filter) && (!stage || job.stage === stage) &&
    (!query || `${job.customer} ${job.orderNumber} ${job.workerName ?? ""} ${job.garment} ${job.batchNumber} ${job.size ?? ""} ${job.color ?? ""} ${stageLabel(job.stage)}`.toLowerCase().includes(query)))
    .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber) || STAGES.indexOf(a.stage as typeof STAGES[number]) - STAGES.indexOf(b.stage as typeof STAGES[number]));
  const filteredInspections = inspections.filter((check) => (!stage || check.stage === stage) &&
    (!query || `${check.customer} ${check.orderNumber} ${check.workerName ?? ""} ${check.inspectedBy} ${check.batchNumber} ${stageLabel(check.stage)}`.toLowerCase().includes(query)));

  return <div className="mx-auto max-w-6xl">
    <PageHeader title="Production History" subtitle="Find a school first. Inspect jobs and their recorded outcomes without losing the full production trail." />
    <div className="mb-4 grid grid-cols-2 gap-2">
      <button type="button" onClick={() => setTab("ledger")} aria-pressed={tab === "ledger"}
        className={`min-h-12 rounded-xl border p-2 text-sm font-semibold ${tab === "ledger" ? "border-matesther-800 bg-matesther-800 text-white" : "border-slate-200 bg-white text-slate-700"}`}>Stage Ledger <span className="text-xs opacity-80">({jobs.length})</span></button>
      <button type="button" onClick={() => setTab("inspections")} aria-pressed={tab === "inspections"}
        className={`min-h-12 rounded-xl border p-2 text-sm font-semibold ${tab === "inspections" ? "border-matesther-800 bg-matesther-800 text-white" : "border-slate-200 bg-white text-slate-700"}`}>Inspections <span className="text-xs opacity-80">({inspections.length})</span></button>
    </div>
    {tab === "ledger" && <div className="mb-4 grid grid-cols-3 gap-2">{([
      { key: "active", label: "Active" }, { key: "completed", label: "Completed" }, { key: "all", label: "All stages" },
    ] as { key: LedgerFilter; label: string }[]).map((choice) =>
      <button key={choice.key} type="button" aria-pressed={filter === choice.key} onClick={() => setFilter(choice.key)}
        className={`min-h-12 rounded-lg border px-2 py-2 text-xs font-semibold sm:text-sm ${filter === choice.key ? "border-gold-500 bg-amber-50 text-matesther-900" : "border-slate-200 bg-white text-slate-600"}`}>
        {choice.label}
        {/* Only the selected filter was counted by the database, so only that one
            can show a truthful total. The others used to show a count of rows the
            browser happened to have downloaded. */}
        {filter === choice.key && <span className="ml-1 text-xs">{total}</span>}
      </button>)}</div>}
    {tab === "ledger" && !loading && total > jobs.length && (
      <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-3">
        <p className="text-xs text-slate-600">Showing <strong>{jobs.length}</strong> of <strong>{total}</strong> stage records.</p>
        <Btn variant="secondary" onClick={loadMore}>Load {Math.min(PAGE_SIZE, total - jobs.length)} more</Btn>
      </Card>
    )}
    <Card className="mb-4 flex flex-wrap gap-3 p-3 sm:p-4">
      <div className="relative min-w-0 flex-1 basis-full sm:basis-60"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input className={`${inputCls} pl-9`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a school, worker or garment" aria-label="Search production history" />
      </div>
      <select className={`${inputCls} w-full sm:w-auto sm:min-w-40`} value={stage} onChange={(event) => setStage(event.target.value)} aria-label="Filter history by production stage">
        <option value="">All stages</option>{STAGES.map((step) => <option key={step} value={step}>{stageLabel(step)}</option>)}
      </select>
    </Card>
    {error ? <Card className="p-5 text-sm text-red-700"><div role="alert"><p>{error}</p><Btn className="mt-3" onClick={() => void load()}>Try again</Btn></div></Card>
      : loading ? <Card><Loading label="Loading production history..." /></Card>
      : tab === "ledger" ? <SchoolOrderGroups rows={filteredJobs} emptyTitle="No stages match this view" emptyHint="Try another stage, status or school. Empty future stages are under All stages." itemLabel="stage" renderItem={(job) =>
        <div className="h-full rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm font-bold text-matesther-900">{stageLabel(job.stage)}</p><Badge status={job.status} /></div>
          <p className="mt-1 text-sm font-medium text-slate-700">{job.garment}{job.size ? ` • Size ${job.size}` : ""}{job.color ? ` • ${job.color}` : ""}</p>
          <p className="mt-1 text-xs text-slate-500">{job.batchNumber} • {job.workerName || "Unassigned"}</p>
          <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-2 text-center text-xs sm:grid-cols-6">{metrics.map(({ field, label }) =>
            <div key={field}><span className="block text-slate-500">{label}</span><strong className={`text-sm ${field === "quantityApproved" ? "text-emerald-700" : field === "quantityRejected" ? "text-red-700" : "text-slate-900"}`}>{job[field]}</strong></div>)}</div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500"><span className="inline-flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" /> Given {fmtDate(job.assignedAt)}</span><span>Expected {fmtDate(job.expectedCompletionDate)}</span>{job.completedAt && <span>Finished {fmtDate(job.completedAt)}</span>}</div>
          {job.notes && <p className="mt-2 rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600">{job.notes}</p>}
        </div>}
      /> : <>
        {inspections.length >= 500 && <p className="mb-3 text-xs text-slate-500">Showing the latest 500 inspections. Narrow your search for a specific school.</p>}
        <SchoolOrderGroups rows={filteredInspections} emptyTitle="No inspection records match" emptyHint="Try a different school or stage." itemLabel="inspection" renderItem={(record) =>
          <div className="h-full rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm font-bold text-matesther-900">{stageLabel(record.stage)}</p><span className="text-xs text-slate-500">{fmtDateTime(record.inspectedAt)}</span></div>
            <p className="mt-1 text-xs text-slate-600">Batch {record.batchNumber} • Worker {record.workerName || "Unassigned"}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 font-semibold text-emerald-700"><CheckCircle2 className="h-3 w-3" /> {record.quantityApproved} approved</span>{record.quantityRework > 0 && <span className="rounded-full bg-amber-50 px-2 py-1 font-semibold text-amber-700">{record.quantityRework} rework</span>}{record.quantityRejected > 0 && <span className="rounded-full bg-red-50 px-2 py-1 font-semibold text-red-700">{record.quantityRejected} rejected</span>}</div>
            <p className="mt-2 inline-flex items-center gap-1 text-xs text-slate-500"><ClipboardCheck className="h-3.5 w-3.5" /> Inspected by {record.inspectedBy}</p>
            {record.notes && <p className="mt-2 rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600">{record.notes}</p>}
          </div>}
        />
      </>}
  </div>;
}
