"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, ClipboardCheck, Search, UserRoundPlus } from "lucide-react";
import { Badge, Btn, Card, Loading, PageHeader, inputCls } from "@/components/ui";
import { SchoolOrderGroups } from "@/components/SchoolOrderGroups";
import { fmtDate, stageLabel, STAGES } from "@/lib/format";

type Job = {
  id: number; orderId: number | null; orderNumber: string; customer: string;
  garment: string; batchNumber: string; stage: string; workerName: string | null; workerId: number | null;
  size: string | null; color: string | null; quantityReceived: number; quantityCompleted: number;
  quantityApproved: number; quantityRemaining: number; pendingInspection: number;
  expectedCompletionDate: string | null; status: string;
};
type Filter = "working" | "submitted" | "unassigned" | "all";
const OPTIONS: { key: Filter; label: string }[] = [
  { key: "working", label: "Being worked" }, { key: "submitted", label: "For inspection" },
  { key: "unassigned", label: "Ready to assign" }, { key: "all", label: "All live" },
];

export default function WorkerAssignmentsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Filter>("working");
  const [stage, setStage] = useState("");
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/operations", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data)) throw new Error(data.error || "Assignments could not be loaded.");
      setJobs(data.filter((job: Job) => job.orderId && job.quantityReceived > 0 && ["PENDING", "IN_PROGRESS", "SUBMITTED", "ON_HOLD"].includes(job.status)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Assignments could not be loaded."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const matchesTab = (job: Job, selected: Filter) => selected === "all" ||
    selected === "working" && !!job.workerId && ["IN_PROGRESS", "PENDING", "ON_HOLD"].includes(job.status) ||
    selected === "submitted" && (job.status === "SUBMITTED" || job.pendingInspection > 0) ||
    selected === "unassigned" && !job.workerId;
  const counts = Object.fromEntries(OPTIONS.map((option) => [option.key, jobs.filter((job) => matchesTab(job, option.key)).length]));
  const query = search.trim().toLowerCase();
  const filtered = jobs.filter((job) => matchesTab(job, tab) && (!stage || job.stage === stage) &&
    (!query || `${job.customer} ${job.orderNumber} ${job.garment} ${job.stage} ${job.workerName ?? ""} ${job.batchNumber} ${job.size ?? ""} ${job.color ?? ""}`.toLowerCase().includes(query)))
    .sort((a, b) => (a.expectedCompletionDate ?? "9999").localeCompare(b.expectedCompletionDate ?? "9999") || a.orderNumber.localeCompare(b.orderNumber));

  return <div className="mx-auto max-w-6xl">
    <PageHeader title="Worker Assignments" subtitle="School orders first, then each garment and worker. Choose a view to focus on what needs attention." />
    <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">{OPTIONS.map((option) =>
      <button key={option.key} type="button" aria-pressed={tab === option.key} onClick={() => setTab(option.key)}
        className={`min-h-14 rounded-xl border px-3 py-2 text-left text-sm font-semibold transition-colors ${tab === option.key ? "border-matesther-800 bg-matesther-800 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-matesther-500"}`}>
        <span className="block">{option.label}</span><span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs ${tab === option.key ? "bg-white/20" : "bg-slate-100"}`}>{counts[option.key] ?? 0}</span>
      </button>)}</div>
    <Card className="mb-4 flex flex-wrap gap-3 p-3 sm:p-4">
      <div className="relative min-w-0 flex-1 basis-full sm:basis-60"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input className={`${inputCls} pl-9`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find school, worker or garment" aria-label="Find a worker assignment" />
      </div>
      <select aria-label="Filter by production stage" className={`${inputCls} w-full sm:w-auto sm:min-w-40`} value={stage} onChange={(event) => setStage(event.target.value)}>
        <option value="">All stages</option>{STAGES.map((step) => <option key={step} value={step}>{stageLabel(step)}</option>)}
      </select>
    </Card>
    {error ? <Card className="p-5 text-sm text-red-700"><div role="alert"><p>{error}</p><Btn className="mt-3" onClick={() => void load()}>Try again</Btn></div></Card>
      : loading ? <Card><Loading label="Loading assignments..." /></Card>
      : <SchoolOrderGroups rows={filtered} emptyTitle={search || stage ? "No assignments match these filters" : `No ${OPTIONS.find((option) => option.key === tab)?.label.toLowerCase()} jobs`} emptyHint="New jobs appear when garments are received at a production stage." renderItem={(job) =>
        <div className="h-full rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm font-bold text-matesther-900">{stageLabel(job.stage)}</p><Badge status={job.status} /></div>
          <p className="mt-1 text-sm font-medium text-slate-700">{job.garment}{job.size ? ` • Size ${job.size}` : ""}{job.color ? ` • ${job.color}` : ""}</p>
          <p className="mt-1 text-xs text-slate-500">Batch {job.batchNumber}</p>
          <p className="mt-3 text-sm"><span className="text-slate-500">Assigned to: </span><span className={job.workerName ? "font-semibold text-slate-900" : "font-semibold text-amber-700"}>{job.workerName || "Needs a worker"}</span></p>
          <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-2 text-center text-xs"><div><span className="block text-slate-500">Received</span><strong className="text-sm">{job.quantityReceived}</strong></div><div><span className="block text-slate-500">Approved</span><strong className="text-sm text-emerald-700">{job.quantityApproved}</strong></div><div><span className="block text-slate-500">Left</span><strong className="text-sm">{job.quantityRemaining}</strong></div></div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs"><span className="inline-flex items-center gap-1 text-slate-500"><CalendarClock className="h-3.5 w-3.5" /> Due {fmtDate(job.expectedCompletionDate)}</span>{job.pendingInspection > 0 && <span className="inline-flex items-center gap-1 font-semibold text-violet-700"><ClipboardCheck className="h-3.5 w-3.5" /> {job.pendingInspection} awaiting check</span>}</div>
          <Link href={`/production?stage=${job.stage}`} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-matesther-200 bg-matesther-50 px-3 text-xs font-bold text-matesther-800 hover:bg-matesther-100"><UserRoundPlus className="h-4 w-4" /> Open production job</Link>
        </div>}
      />}
  </div>;
}
