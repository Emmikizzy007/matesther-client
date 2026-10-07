"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Info } from "lucide-react";
import { Btn, Card, EmptyState, Loading, PageHeader, inputCls } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { stageLabel } from "@/lib/format";

/**
 * PRODUCTION CONTROL.
 *
 * One question per exact garment variant: where is this work, how much is left, whose
 * hands is it in, and what is stopping it.
 *
 * THIS SCREEN CHANGES NOTHING AND CANNOT. There is no input, no save and no editable
 * quantity anywhere on it - deliberately. Every figure is derived server-side from the
 * production movement ledger, the route frozen on the batch, the live allocations and the
 * inspection history. Work is moved where it has always been moved: by submitting it,
 * inspecting it, or recording an audited correction with a reason. That is what keeps this
 * board incapable of disagreeing with the record behind it.
 *
 * It is also route-aware in the only sense that matters: "current stage" is a position on
 * THIS batch's own frozen route, so a route that skips monogramming or runs ironing before
 * packing reports its own order rather than the global eight-stage list.
 */

type StageWorker = { workerId: number; name: string; quantity: number; remaining: number };
type StageControl = {
  operationId: number; position: number; stage: string; method: string | null; status: string;
  received: number; submitted: number; approved: number; rework: number; rejected: number;
  remaining: number; awaitingInspection: number; assigned: number; workers: StageWorker[];
  openDispatches: number; isCurrent: boolean;
  /**
   * Support work handed out from this stage - the part a tailor gave to a helper - or
   * NULL when the stage has none. Nullable to match the API: most stages of most batches
   * have no support work, and sending a zeroed object for each of them was 48 KB of
   * nothing on a full board. Every read below therefore has to ask first.
   */
  support: StageSupport | null;
};
/** What one stage owes to support work. Mirrors StageSupport in lib/support-work.ts. */
type StageSupport = {
  delegated: number; approved: number; rework: number; rejected: number; outstanding: number;
  active: number; paused: number; pausedReason: string | null; reworkOpen: number; blocking: boolean;
};
/** The batch-level rollup of that, across the whole route. */
type SupportRoll = {
  delegated: number; approved: number; outstanding: number; paused: number; reworkOpen: number;
  blocking: boolean; pausedStages: { stage: string; reason: string | null }[];
};
type ControlRow = {
  batchId: number; batchNumber: string | null; orderId: number; orderNumber: string;
  orderStatus: string; school: string; dueDate: string | null; daysToDue: number | null;
  product: string | null; variant: string | null; size: string | null; color: string | null;
  ordered: number; finished: number; remaining: number;
  currentPosition: number | null; currentStage: string | null; routeLength: number;
  assigned: number; awaitingInspection: number; awaitingInspectionTotal: number;
  rework: number; rejected: number;
  bottleneck: { position: number; stage: string; quantity: number } | null;
  support: SupportRoll;
  flags: string[]; stuck: boolean; priority: number; priorityLabel: string;
  route: StageControl[];
};
type OrderRoll = {
  orderId: number; orderNumber: string; school: string; dueDate: string | null;
  daysToDue: number | null; ordered: number; finished: number; remaining: number;
  assigned: number; awaitingInspection: number; rework: number; rejected: number;
  batches: number; stages: { stage: string; quantity: number }[];
  support: SupportRoll;
  priority: number; priorityLabel: string; stuck: boolean; flags: string[];
};

const PRIORITY_TONE: Record<number, string> = {
  1: "bg-red-100 text-red-800 border-red-300",
  2: "bg-orange-100 text-orange-800 border-orange-300",
  3: "bg-amber-100 text-amber-800 border-amber-300",
  4: "bg-sky-100 text-sky-800 border-sky-300",
  5: "bg-slate-100 text-slate-700 border-slate-300",
  6: "bg-emerald-100 text-emerald-800 border-emerald-300",
};

const FLAG_LABELS: Record<string, string> = {
  OVERDUE: "Past due date",
  DUE_SOON: "Due within 3 days",
  AWAITING_INSPECTION: "Work submitted, not yet inspected",
  REWORK_PENDING: "Rework outstanding",
  OUTSOURCED_WAITING: "Out with a vendor, not yet back",
  UNASSIGNED: "Holding work nobody is assigned to",
  WAITING_UPSTREAM: "Nothing has reached this stage yet",
  NO_ROUTE: "No stage to do the remaining work at",
  COMPLETE: "Finished",
  /* ---- support work is part of the chain, so it gets its own words ----
   *
   * SUPPORT_PAUSED is the one that matters most: it is the difference between a stage
   * that looks busy and a stage that is standing still because a helper stopped. The
   * reason is rendered beside it, because "paused" with no reason is not actionable.
   */
  SUPPORT_PAUSED: "Support worker has paused",
  SUPPORT_REWORK: "Support work sent back to the helper",
  SUPPORT_IN_PROGRESS: "Part of this stage is with a support worker",
};

const PAGE_SIZE = 25;

function dueLabel(daysToDue: number | null): { text: string; tone: string } {
  if (daysToDue === null) return { text: "No due date", tone: "text-slate-500" };
  if (daysToDue < 0) return { text: `${Math.abs(daysToDue)} day${Math.abs(daysToDue) === 1 ? "" : "s"} late`, tone: "text-red-700 font-bold" };
  if (daysToDue === 0) return { text: "Due today", tone: "text-orange-700 font-bold" };
  return { text: `Due in ${daysToDue} day${daysToDue === 1 ? "" : "s"}`, tone: daysToDue <= 3 ? "text-orange-700 font-semibold" : "text-slate-600" };
}

export default function ProductionControlPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ControlRow[]>([]);
  const [orderRolls, setOrderRolls] = useState<OrderRoll[]>([]);
  const [total, setTotal] = useState(0);
  const [window, setWindow] = useState<{ derived: number; capped: boolean; cap: number } | null>(null);
  const [appliedLate, setAppliedLate] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<Record<string, string>>({});
  const [stages, setStages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [grain, setGrain] = useState<"batch" | "order">("batch");
  const [openBatch, setOpenBatch] = useState<number | null>(null);

  // Filters. `draft` is what is typed; `applied` is what was actually queried, so
  // pressing Enter or Apply is what runs a request rather than every keystroke.
  const [draft, setDraft] = useState({ search: "", stage: "", priority: "", dueWithinDays: "", blockedOnly: false, supportPausedOnly: false, all: false });
  const [applied, setApplied] = useState(draft);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (applied.search.trim()) params.set("search", applied.search.trim());
    if (applied.stage) params.set("stage", applied.stage);
    if (applied.priority) params.set("priority", applied.priority);
    if (applied.dueWithinDays) params.set("dueWithinDays", applied.dueWithinDays);
    if (applied.blockedOnly) params.set("blockedOnly", "1");
    if (applied.supportPausedOnly) params.set("supportPausedOnly", "1");
    if (applied.all) params.set("all", "1");
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(page * PAGE_SIZE));
    return params.toString();
  }, [applied, page]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/production-control?${queryString}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load production control.");
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setOrderRolls(Array.isArray(data.orders) ? data.orders : []);
      setTotal(Number(data.total) || 0);
      setWindow(data.window ?? null);
      setAppliedLate(Array.isArray(data.appliedAfterDerivation) ? data.appliedAfterDerivation : []);
      setPriorities(data.priorities ?? {});
      setStages(Array.isArray(data.stages) ? data.stages : []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load production control.");
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => { void load(); }, [load]);

  function apply(next: Partial<typeof draft>) {
    setDraft((current) => ({ ...current, ...next }));
    setApplied((current) => ({ ...current, ...next }));
    setPage(0);
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Production Control"
        subtitle="Where every exact garment is on its own route, what is left, who holds it, and what is stopping it"
        action={<Link href="/production"><Btn variant="ghost"><ArrowLeft className="w-4 h-4 mr-2" />Active production</Btn></Link>}
      />

      <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 flex gap-2">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <p>
          <span className="font-semibold">Every figure on this board is derived and read-only.</span>{" "}
          Quantities come from the production movement ledger, the route frozen on each batch, the live
          allocations and the inspection history. Nothing here can be typed into, so nothing here can
          disagree with the record behind it. To move work, submit it, inspect it, or record an audited
          correction with a reason.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 flex gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{error}
        </div>
      )}

      <Card>
        <div className="grid gap-3 md:grid-cols-6 items-end">
          <label className="md:col-span-2 text-xs font-semibold text-slate-600">
            School or order number
            <input
              className={inputCls}
              value={draft.search}
              placeholder="Search"
              onChange={(event) => setDraft((c) => ({ ...c, search: event.target.value }))}
              onKeyDown={(event) => { if (event.key === "Enter") apply({ search: draft.search }); }}
            />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Current stage
            <select className={inputCls} value={draft.stage} onChange={(event) => apply({ stage: event.target.value })}>
              <option value="">Any stage</option>
              {stages.map((stage) => <option key={stage} value={stage}>{stageLabel(stage)}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Priority
            <select className={inputCls} value={draft.priority} onChange={(event) => apply({ priority: event.target.value })}>
              <option value="">Any priority</option>
              {Object.entries(priorities).map(([rank, label]) => <option key={rank} value={rank}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Due within
            <select className={inputCls} value={draft.dueWithinDays} onChange={(event) => apply({ dueWithinDays: event.target.value })}>
              <option value="">Any date</option>
              <option value="0">Due today or late</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
          <div className="flex gap-2 items-center">
            <label className="text-xs font-semibold text-slate-600 flex items-center gap-1">
              <input type="checkbox" checked={draft.blockedOnly} onChange={(event) => apply({ blockedOnly: event.target.checked })} />
              Blocked only
            </label>
            {/* Narrow to work a support worker has stopped, which is its own question:
                "Blocked only" also catches inspection queues and unassigned stages. */}
            <label className="text-xs font-semibold text-slate-600 flex items-center gap-1">
              <input type="checkbox" checked={draft.supportPausedOnly} onChange={(event) => apply({ supportPausedOnly: event.target.checked })} />
              Support paused
            </label>
            <label className="text-xs font-semibold text-slate-600 flex items-center gap-1">
              <input type="checkbox" checked={draft.all} onChange={(event) => apply({ all: event.target.checked })} />
              Include closed
            </label>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <Btn variant="ghost" onClick={() => void load()}>Refresh</Btn>
          <div className="ml-auto flex gap-1 rounded-lg border border-slate-300 p-0.5">
            {(["batch", "order"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setGrain(option)}
                className={`px-3 py-1 rounded-md text-xs font-semibold ${grain === option ? "bg-slate-800 text-white" : "text-slate-600"}`}
              >
                {option === "batch" ? "Per garment" : "Per school order"}
              </button>
            ))}
          </div>
        </div>
        {appliedLate.length > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            {appliedLate.map((name) => ({ stage: "Current stage", priority: "Priority", blockedOnly: "Blocked only", supportPausedOnly: "Support paused" }[name] ?? name)).join(", ")}{" "}
            is decided from derived figures, so it narrows the {window?.derived ?? 0} most urgent batches
            {window?.capped ? ` (the busiest ${window.cap} - narrow the filters to see further)` : ""}.
          </p>
        )}
      </Card>

      {loading ? <Loading /> : grain === "order" ? (
        <OrderTable rolls={orderRolls} onShow={(orderNumber) => apply({ search: orderNumber })} />
      ) : (
        <div className="space-y-3">
          {rows.length === 0 && (
            <EmptyState
              title="Nothing in production matches these filters"
              hint="Widen the filters, or include closed orders, to see finished work."
            />
          )}
          {rows.map((row) => {
            const open = openBatch === row.batchId;
            const due = dueLabel(row.daysToDue);
            return (
              <Card key={row.batchId}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setOpenBatch(open ? null : row.batchId)}
                  aria-expanded={open}
                >
                  <div className="flex flex-wrap items-start gap-3">
                    {open ? <ChevronDown className="w-4 h-4 mt-1 text-slate-500" /> : <ChevronRight className="w-4 h-4 mt-1 text-slate-500" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ${PRIORITY_TONE[row.priority] ?? PRIORITY_TONE[5]}`}>
                          {row.priorityLabel}
                        </span>
                        <span className="font-bold text-slate-900">{row.school}</span>
                        <span className="text-sm text-slate-500">{row.orderNumber}</span>
                        {row.stuck && (
                          <span className="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border bg-red-50 text-red-700 border-red-300">
                            Stuck
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-700 mt-0.5">
                        {[row.product, row.variant].filter(Boolean).join(" — ") || "Garment not recorded"}
                        {row.batchNumber ? <span className="text-slate-400"> · {row.batchNumber}</span> : null}
                      </p>
                      <p className={`text-xs mt-0.5 ${due.tone}`}>{due.text}{row.dueDate ? ` · ${row.dueDate}` : ""}</p>
                    </div>
                    <dl className="grid grid-cols-3 sm:grid-cols-6 gap-x-4 gap-y-1 text-right">
                      {[
                        ["Ordered", row.ordered],
                        ["Approved", row.finished],
                        ["Remaining", row.remaining],
                        ["At stage", row.currentStage ? stageLabel(row.currentStage) : "—"],
                        ["Assigned", row.assigned],
                        ["Awaiting check", row.awaitingInspectionTotal],
                      ].map(([label, value]) => (
                        <div key={String(label)}>
                          <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
                          <dd className="text-sm font-bold text-slate-900">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  {row.flags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {row.flags.map((flag) => (
                        <span key={flag} className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                          {FLAG_LABELS[flag] ?? flag}
                        </span>
                      ))}
                      {row.bottleneck && (
                        <span className="text-[11px] px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-semibold">
                          Bottleneck: {stageLabel(row.bottleneck.stage)} holding {row.bottleneck.quantity}
                        </span>
                      )}
                      {/* The delegation maths, on the board: what was handed out, what has
                          been accepted, what is still out. A stage's own remaining figure
                          is not interpretable without it. */}
                      {row.support.delegated > 0 && (
                        <span className="text-[11px] px-2 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 font-semibold">
                          Support: {row.support.delegated} handed out · {row.support.approved} approved · {row.support.outstanding} still out
                        </span>
                      )}
                      {/* The pause is named with its reason and its stage, because that is
                          the whole point of the lifecycle: a controller can act on it. */}
                      {row.support.pausedStages.map((paused, index) => (
                        <span key={`${paused.stage}-${index}`} className="text-[11px] px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-300 font-semibold">
                          {stageLabel(paused.stage)} support paused{paused.reason ? `: ${paused.reason}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </button>

                {open && (
                  <div className="mt-4 border-t border-slate-200 pt-3 overflow-x-auto">
                    <p className="text-xs font-semibold text-slate-600 mb-2">
                      This batch&apos;s own frozen route — {row.routeLength} stage{row.routeLength === 1 ? "" : "s"}
                    </p>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-slate-500 border-b border-slate-200">
                          {["#", "Stage", "Method", "Received", "Submitted", "Approved", "Rework", "Rejected", "Remaining", "Awaiting check", "Assigned", "Support handed out", "Who holds it"].map((head) => (
                            <th key={head} className="py-1 pr-3 font-semibold whitespace-nowrap">{head}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {row.route.map((stage) => (
                          <tr key={stage.operationId} className={`border-b border-slate-100 ${stage.isCurrent ? "bg-sky-50" : ""}`}>
                            <td className="py-1.5 pr-3 text-slate-500">{stage.position}</td>
                            <td className="py-1.5 pr-3 font-semibold text-slate-800 whitespace-nowrap">
                              {stageLabel(stage.stage)}{stage.isCurrent ? <span className="ml-1 text-[10px] text-sky-700">◀ current</span> : null}
                            </td>
                            <td className="py-1.5 pr-3 text-slate-600 whitespace-nowrap">{stage.method ?? "INTERNAL"}</td>
                            <td className="py-1.5 pr-3">{stage.received}</td>
                            <td className="py-1.5 pr-3">{stage.submitted}</td>
                            <td className="py-1.5 pr-3 font-semibold">{stage.approved}</td>
                            <td className="py-1.5 pr-3">{stage.rework || ""}</td>
                            <td className="py-1.5 pr-3">{stage.rejected || ""}</td>
                            <td className="py-1.5 pr-3 font-semibold">{stage.remaining}</td>
                            <td className="py-1.5 pr-3">{stage.awaitingInspection || ""}</td>
                            <td className="py-1.5 pr-3">{stage.assigned || ""}</td>
                            {/* The part of this stage a tailor gave to a helper. Read as
                                "20 out, 15 accepted, 5 still owed", and in red when the
                                helper has stopped - which is the state that would otherwise
                                leave the stage looking merely in progress. */}
                            <td className="py-1.5 pr-3 whitespace-nowrap">
                              {/* `stage.support` is null on a stage nobody delegated from,
                                  so it is asked about before any field is read: dereferencing
                                  it unconditionally would crash the expanded route table on
                                  the first ordinary batch. */}
                              {stage.support && stage.support.delegated > 0 ? (
                                <span className={stage.support.paused > 0 ? "font-semibold text-red-700" : "text-slate-600"}>
                                  {stage.support.delegated} out · {stage.support.approved} ok · {stage.support.outstanding} owed
                                  {stage.support.paused > 0 ? " · PAUSED" : ""}
                                  {stage.support.paused > 0 && stage.support.pausedReason ? ` (${stage.support.pausedReason})` : ""}
                                </span>
                              ) : ""}
                            </td>
                            <td className="py-1.5 pr-3 text-slate-600">
                              {stage.workers.length
                                ? stage.workers.map((worker) => `${worker.name}${worker.quantity ? ` (${worker.quantity})` : ""}`).join(", ")
                                : stage.openDispatches > 0 ? `${stage.openDispatches} dispatch out` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-[11px] text-slate-500">
                      Ordered {row.ordered} − approved at the final stage {row.finished} = remaining {row.remaining}.
                      Rework and rejected are totals across the whole route.
                      {row.support.delegated > 0
                        ? ` Support work: ${row.support.delegated} handed out, ${row.support.approved} accepted, ${row.support.outstanding} still owed.`
                        : ""}
                      {user?.role === "OWNER" ? " Open the order for cost and profitability." : ""}
                    </p>
                    {user?.role === "OWNER" && (
                      <Link className="text-xs font-semibold text-sky-700 hover:underline" href={`/orders/${row.orderId}`}>
                        Open {row.orderNumber}
                      </Link>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {!loading && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">
            Showing {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}
          </span>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} >Previous</Btn>
            <span className="px-2 py-1 text-slate-600">Page {page + 1} of {pageCount}</span>
            <Btn variant="ghost" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>Next</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderTable({ rolls, onShow }: { rolls: OrderRoll[]; onShow: (orderNumber: string) => void }) {
  if (!rolls.length) {
    return (
      <EmptyState
        title="Nothing in production matches these filters"
        hint="Widen the filters, or include closed orders, to see finished work."
      />
    );
  }
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              {["Priority", "School", "Order", "Due", "Garments", "Ordered", "Approved", "Remaining", "Assigned", "Awaiting check", "Rework", "Rejected", "Where the work is", ""].map((head) => (
                <th key={head} className="py-2 pr-3 font-semibold whitespace-nowrap">{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rolls.map((order) => {
              const due = dueLabel(order.daysToDue);
              return (
                <tr key={order.orderId} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3">
                    <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded border whitespace-nowrap ${PRIORITY_TONE[order.priority] ?? PRIORITY_TONE[5]}`}>
                      {order.priorityLabel}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-semibold text-slate-900 whitespace-nowrap">{order.school}</td>
                  <td className="py-2 pr-3 text-slate-600 whitespace-nowrap">{order.orderNumber}</td>
                  <td className={`py-2 pr-3 text-xs whitespace-nowrap ${due.tone}`}>{due.text}</td>
                  <td className="py-2 pr-3 text-slate-600">{order.batches}</td>
                  <td className="py-2 pr-3">{order.ordered}</td>
                  <td className="py-2 pr-3 font-semibold">{order.finished}</td>
                  <td className="py-2 pr-3 font-bold">{order.remaining}</td>
                  <td className="py-2 pr-3">{order.assigned}</td>
                  <td className="py-2 pr-3">{order.awaitingInspection}</td>
                  <td className="py-2 pr-3">{order.rework || ""}</td>
                  <td className="py-2 pr-3">{order.rejected || ""}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {order.stages.length
                      ? order.stages.map((stage) => `${stageLabel(stage.stage)} ${stage.quantity}`).join(", ")
                      : "—"}
                  </td>
                  <td className="py-2 pr-3">
                    <Btn variant="ghost" onClick={() => onShow(order.orderNumber)}>Show garments</Btn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        One line per school order, rolled up from the same derived rows: the order is as urgent as its most
        urgent garment and as blocked as any of them.
      </p>
    </Card>
  );
}
