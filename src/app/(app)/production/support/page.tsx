"use client";

import { useEffect, useState } from "react";
import { HandHelping, Plus, ClipboardCheck, Send, Play, Pause, RotateCcw } from "lucide-react";
import { Card, CardHeader, PageHeader, Badge, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira, fmtDate, SUPPORT_OPERATIONS, SUPPORT_ROLE, personHoldsRole } from "@/lib/format";
import { useAuth } from "@/lib/auth";

/**
 * How each lifecycle state reads, in the badge vocabulary the rest of the ERP uses.
 *
 * STARTED and PAUSED are new states and get their own colours rather than borrowing
 * ASSIGNED's: the whole point of the lifecycle is that "nobody has begun", "the helper
 * is working" and "the helper has stopped" are three different facts, and a board that
 * renders all three the same cannot show the pause that is holding up a stage.
 */
const STATUS: Record<string, string> = {
  ASSIGNED: "PENDING",
  STARTED: "IN_PROGRESS",
  PAUSED: "ON_HOLD",
  SUBMITTED: "PENDING",
  APPROVED: "COMPLETED",
  REWORK: "ON_HOLD",
  CANCELLED: "CANCELLED",
};

export default function SupportWorkPage() {
  const { user } = useAuth();
  const isWorker = user?.role === "WORKER";

  const [rows, setRows] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  /**
   * The production that can be handed out from, as the SERVER computes it.
   *
   * One source per share or stage job, each with the exact order, garment, size, colour
   * and stage, and with the most that may still be handed out for each supporting
   * operation. The button, the dropdown and the quantity ceiling all read this one list,
   * and the write path checks against the same arithmetic - so what is offered is what
   * will be accepted. A Worker gets only their own production; a supervisor gets the
   * bounded organisation view.
   */
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [formErr, setFormErr] = useState("");
  const [saving, setSaving] = useState(false);

  const [assignOpen, setAssignOpen] = useState(false);
  const [form, setForm] = useState<{
    workerId: string;
    operation: string;
    quantityAssigned: string;
    pieceRate: string;
    /** "share:<id>" or "stage:<id>" - the production the work is handed out from. */
    source: string;
    notes: string;
  }>({ workerId: "", operation: SUPPORT_OPERATIONS[0], quantityAssigned: "", pieceRate: "", source: "", notes: "" });
  const [submitFor, setSubmitFor] = useState<any>(null);
  const [submitQty, setSubmitQty] = useState("");
  const [inspectFor, setInspectFor] = useState<any>(null);
  const [inspectForm, setInspectForm] = useState({ quantityApproved: "", quantityRework: "", quantityRejected: "", notes: "" });
  /** The row a pause or cancel reason is being written for, and the reason itself. */
  const [reasonFor, setReasonFor] = useState<{ row: any; action: "pause" | "cancel" } | null>(null);
  const [reasonText, setReasonText] = useState("");

  /** Fetch everything the page needs. Does no state setting, so it is safe to
   *  call from an effect and from a refresh after a mutation. */
  function fetchAll() {
    return Promise.all([
      fetch("/api/support-work", { cache: "no-store" }).then((r) => r.json()),
      /**
       * WHO MAY BE HANDED WORK, from the purpose-limited view rather than the staff list.
       *
       * This used to call `/api/workers?view=slim`, which is STAFF-only, and to swallow
       * the 403 with `.catch(() => [])`. For a tailor signed in as a Worker that meant an
       * always-empty helper dropdown, so the form could never be completed and handing out
       * support work looked impossible - which is exactly what was reported from the
       * factory floor. `?supportHelpers=1` is answered for a linked Worker too, and returns
       * only people who hold the Support Worker role, with no pay rate and no contact
       * details, because that is all this picker needs.
       */
      fetch("/api/workers?supportHelpers=1", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
      // The production this login may hand out from, with the ceilings the server will
      // enforce. Bounded by the server; a Worker gets only their own production.
      fetch("/api/support-work?delegable=1", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
    ]);
  }

  function apply([support, people, delegable]: [any, any, any]) {
    if (support && support.error) setErr(support.error);
    else setRows(Array.isArray(support) ? support : []);
    setWorkers(Array.isArray(people) ? people : []);
    setSources(Array.isArray(delegable) ? delegable : []);
  }

  function load() {
    setLoading(true);
    setErr("");
    fetchAll()
      .then(apply)
      .catch(() => setErr("Unable to load support work."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let active = true;
    fetchAll()
      .then((result) => { if (active) apply(result); })
      .catch(() => { if (active) setErr("Unable to load support work."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function assign(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormErr("");
    try {
      const response = await fetch("/api/support-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workerId: Number(form.workerId),
          operation: form.operation,
          quantityAssigned: Number(form.quantityAssigned),
          pieceRate: Number(form.pieceRate) || 0,
          notes: form.notes,
          // The source is named by id; the server inherits the order, item, variant, size,
          // colour and stage from it and records the work against the tailor who holds it.
          ...sourceIds(form.source),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to record this support assignment.");
      setAssignOpen(false);
      load();
    } catch (cause) {
      setFormErr(cause instanceof Error ? cause.message : "Unable to record this support assignment.");
    } finally {
      setSaving(false);
    }
  }

  async function submitWork(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormErr("");
    try {
      const response = await fetch("/api/support-work", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: submitFor.id, submitQty: Number(submitQty) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to submit this work.");
      setSubmitFor(null);
      setSubmitQty("");
      load();
    } catch (cause) {
      setFormErr(cause instanceof Error ? cause.message : "Unable to submit this work.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Move one assignment through its lifecycle: start, resume, pause or cancel.
   *
   * The server owns the rule - `SUPPORT_TRANSITIONS` decides what may follow what, and
   * refuses an illegal move with 409 - so this function's job is only to send the action
   * and show the answer. It never decides locally whether a move is allowed, because a
   * button that guesses is a button that lies.
   */
  async function lifecycle(row: any, action: "start" | "resume" | "pause" | "cancel", reason?: string) {
    setSaving(true);
    setFormErr("");
    try {
      const response = await fetch("/api/support-work", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, action, ...(reason ? { reason } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Unable to ${action} this support work.`);
      setReasonFor(null);
      setReasonText("");
      load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `Unable to ${action} this support work.`;
      // A failure in the reason dialog belongs in the dialog; anywhere else it belongs
      // at the top of the page, where the rest of this screen already reports.
      if (reasonFor) setFormErr(message); else setErr(message);
    } finally {
      setSaving(false);
    }
  }

  async function inspect(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormErr("");
    try {
      const response = await fetch("/api/support-work", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: inspectFor.id,
          quantityApproved: Number(inspectForm.quantityApproved) || 0,
          quantityRework: Number(inspectForm.quantityRework) || 0,
          quantityRejected: Number(inspectForm.quantityRejected) || 0,
          notes: inspectForm.notes,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to record this inspection.");
      setInspectFor(null);
      load();
    } catch (cause) {
      setFormErr(cause instanceof Error ? cause.message : "Unable to record this inspection.");
    } finally {
      setSaving(false);
    }
  }

  // The server already returns only Support Worker role holders from the
  // purpose-limited view, so this filter is a second line rather than the only one.
  const helpers = workers.filter((person) => person.status === "ACTIVE" && personHoldsRole(person, SUPPORT_ROLE));

  /**
   * A tailor is a Worker who HOLDS production. That is the whole authorisation
   * relationship: they may delegate part of what they hold, and nothing else.
   *
   * `sources` is the caller's own production for a Worker and the organisation's for a
   * supervisor, computed by the server - so "can hand something out" is the same question
   * the server answers when the form is submitted, and the button is never shown for an
   * action the backend would refuse.
   */
  const myWorkerId = user?.workerId ?? null;
  /** The production that can take a hand-out right now. Decided by the server. */
  const eligibleSources = sources.filter((source) => source.eligible);
  const canHandOut = eligibleSources.length > 0;
  /**
   * Why the action is unavailable, in the words a tailor needs. Shown instead of a button
   * that would fail, so a person can see what to fix rather than guess.
   */
  const handOutUnavailable = (() => {
    if (canHandOut || loading) return "";
    if (isWorker && !myWorkerId)
      return "Your login is not linked to a Workers record yet, so Matesther cannot tell which production is yours. Ask the Owner to add your Workers record under the same full name as your login.";
    if (sources.length === 0)
      return isWorker
        ? "No production is assigned to you right now. Once a stage is assigned to you, you can hand part of it to a support worker from here."
        : "No production is open for hand-outs right now.";
    return sources.find((source) => source.blockedReason)?.blockedReason
      ?? "Everything assigned to you has already been handed out to support workers.";
  })();
  /** Is this row mine to move through its lifecycle? Only the helper who holds it. */
  const isMySupportRow = (row: any) => !!myWorkerId && row.workerId === myWorkerId;
  /**
   * May I judge this row? A supervisor or the tailor who handed it out - never the helper,
   * and that holds even when a supervisor is the helper, because the server refuses it.
   */
  const canInspect = (row: any) =>
    row.pending > 0 && !isMySupportRow(row) && (!isWorker || (!!myWorkerId && row.assignedByWorkerId === myWorkerId));

  /** "share:12" -> { productionAllocationId: 12 }; "stage:7" -> { productionOperationId: 7 }. */
  function sourceIds(key: string): { productionAllocationId?: number; productionOperationId?: number } {
    const [kind, id] = key.split(":");
    if (!id) return {};
    return kind === "share" ? { productionAllocationId: Number(id) } : { productionOperationId: Number(id) };
  }
  /** The chosen source, if any, by its form key. */
  const chosenSource = eligibleSources.find((source) => {
    const [kind, id] = form.source.split(":");
    return kind === (source.kind === "SHARE" ? "share" : "stage")
      && Number(id) === (source.kind === "SHARE" ? source.productionAllocationId : source.productionOperationId);
  });
  /** The most that may be handed out for the operation chosen, on the source chosen. */
  const chosenRemaining = chosenSource
    ? (chosenSource.operations.find((entry: any) => entry.operation === form.operation)?.remaining ?? 0)
    : null;

  return (
    <div>
      <PageHeader
        title="Support Work"
        subtitle="Weaving, taping and other supporting work a tailor hands to a helper. Payable on approved pieces only."
        action={
          // Shown exactly when the server would accept it: a supervisor or Owner always,
          // a Worker only when they hold production to delegate from. A Worker with no
          // share of their own gets no button, rather than a button that fails.
          canHandOut && (
            <Btn onClick={() => { setFormErr(""); setForm({ workerId: "", operation: SUPPORT_OPERATIONS[0], quantityAssigned: "", pieceRate: "", source: "", notes: "" }); setAssignOpen(true); }}>
              <Plus className="w-4 h-4" /> Hand Out Support Work
            </Btn>
          )
        }
      />

      {err && <p className="mb-4 text-sm text-red-700">{err}</p>}
      {handOutUnavailable && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="hand-out-unavailable">
          <strong>Hand out support work is unavailable.</strong> {handOutUnavailable}
        </p>
      )}

      <Card>
        <CardHeader title="Support assignments" subtitle="The tailor keeps their own production job; this records the help alongside it" />
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No support work recorded"
            hint={
              isWorker
                ? canHandOut
                  ? "Support work you have handed out, and work handed to you, both appear here."
                  : "Support work handed to you by a tailor appears here. Once you hold production of your own, you can hand part of it to a support worker from this screen."
                : "Use “Hand Out Support Work” to give a helper part of a garment job."
            }
          />
        ) : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[1080px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Support worker</th>
                  <th className="px-3 py-3">Operation</th>
                  <th className="px-3 py-3">From</th>
                  <th className="px-3 py-3">Order &amp; exact garment</th>
                  <th className="px-3 py-3 text-right">Given</th>
                  <th className="px-3 py-3 text-right">Returned</th>
                  <th className="px-3 py-3 text-right">Approved</th>
                  <th className="px-3 py-3 text-right">Rework</th>
                  <th className="px-3 py-3 text-right">Rejected</th>
                  <th className="px-3 py-3 text-right">Rate</th>
                  <th className="px-3 py-3 text-right">Earned</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-semibold">
                      {row.supportWorker}
                      <span className="block text-xs font-normal text-slate-500">{fmtDate(row.assignedAt)}</span>
                    </td>
                    <td className="px-3 py-3">{row.operation}</td>
                    <td className="px-3 py-3">{row.assignedBy}</td>
                    <td className="px-3 py-3 text-xs">
                      {row.orderNumber}
                      {row.customer !== "-" && <span className="block text-slate-500">{row.customer}</span>}
                      {/* The exact garment: item, size and colour, and the stage it belongs
                          to. A helper is never shown a whole order's quantity in place of
                          the specific variant they were handed. */}
                      {row.garment && (
                        <span className="block font-medium text-slate-700">
                          {row.garment}
                          {row.variant ? ` • ${row.variant}` : ""}
                        </span>
                      )}
                      {row.stage && (
                        <span className="block text-slate-600">{String(row.stage).replaceAll("_", " ")}</span>
                      )}
                      {row.allocation && (
                        <span className="block text-slate-500">
                          {row.allocation.holder}&apos;s share of {row.allocation.quantityAllocated} pcs
                        </span>
                      )}
                      {row.batchNumber && (
                        <span className="block text-slate-400">
                          {row.batchNumber}
                          {!row.variant && row.size ? ` • ${row.size}` : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">{row.quantityAssigned}</td>
                    <td className="px-3 py-3 text-right">{row.quantitySubmitted}</td>
                    <td className="px-3 py-3 text-right font-semibold text-matesther-700">{row.quantityApproved}</td>
                    <td className="px-3 py-3 text-right text-amber-700">{row.quantityRework || "-"}</td>
                    <td className="px-3 py-3 text-right text-red-600">{row.quantityRejected || "-"}</td>
                    <td className="px-3 py-3 text-right">{naira(row.pieceRate)}</td>
                    <td className="px-3 py-3 text-right font-bold text-matesther-700">{naira(row.quantityApproved * row.pieceRate)}</td>
                    <td className="px-3 py-3">
                      <Badge status={STATUS[row.status] ?? row.status} />
                      {/* The pause reason is shown beside the state, because a controller
                          reading "PAUSED" with no reason has nothing to act on. */}
                      {row.status === "PAUSED" && row.pauseReason && (
                        <span className="mt-1 block max-w-[16rem] text-xs text-amber-700">{row.pauseReason}</span>
                      )}
                      {/* What is still owed on this hand-over: the figure that makes the
                          tailor's own remaining quantity interpretable. */}
                      {row.outstanding > 0 && row.status !== "CANCELLED" && (
                        <span className="mt-1 block text-xs text-slate-500">
                          {row.outstanding} of {row.quantityAssigned} still to settle
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {/* Every button below is shown only for a move the server will
                          accept from THIS login on THIS state. Nothing is hidden as a
                          security measure - each action is re-authorised server-side -
                          but neither is a button offered that would only ever fail. */}
                      {canInspect(row) && (
                        <button
                          onClick={() => { setFormErr(""); setInspectFor(row); setInspectForm({ quantityApproved: String(row.pending), quantityRework: "", quantityRejected: "", notes: "" }); }}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-matesther-700 hover:underline"
                        >
                          <ClipboardCheck className="w-3.5 h-3.5" /> Inspect
                        </button>
                      )}
                      {/* The helper's own lifecycle: begin, then hand pieces back. */}
                      {isMySupportRow(row) && ["ASSIGNED", "REWORK"].includes(row.status) && (
                        <button
                          onClick={() => lifecycle(row, "start")}
                          disabled={saving}
                          className="ml-3 inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-matesther-700 disabled:opacity-50"
                        >
                          <Play className="w-3.5 h-3.5" /> Start
                        </button>
                      )}
                      {isMySupportRow(row) && row.status === "PAUSED" && (
                        <button
                          onClick={() => lifecycle(row, "resume")}
                          disabled={saving}
                          className="ml-3 inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-matesther-700 disabled:opacity-50"
                        >
                          <RotateCcw className="w-3.5 h-3.5" /> Resume
                        </button>
                      )}
                      {isMySupportRow(row) && ["STARTED", "SUBMITTED"].includes(row.status) && (
                        <button
                          onClick={() => { setFormErr(""); setReasonText(""); setReasonFor({ row, action: "pause" }); }}
                          disabled={saving}
                          className="ml-3 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 hover:underline disabled:opacity-50"
                        >
                          <Pause className="w-3.5 h-3.5" /> Pause
                        </button>
                      )}
                      {isMySupportRow(row) && ["STARTED", "REWORK"].includes(row.status) && row.quantitySubmitted - row.quantityRework < row.quantityAssigned && (
                        <button
                          onClick={() => { setFormErr(""); setSubmitFor(row); setSubmitQty(""); }}
                          className="ml-3 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-matesther-700"
                        >
                          <Send className="w-3.5 h-3.5" /> Submit work
                        </button>
                      )}
                      {/* Cancelling is the tailor's or a supervisor's, and only while
                          nothing has been submitted - the server holds the same rule. */}
                      {(canInspect(row) || !isWorker) && ["ASSIGNED", "STARTED", "PAUSED"].includes(row.status) && (
                        <button
                          onClick={() => { setFormErr(""); setReasonText(""); setReasonFor({ row, action: "cancel" }); }}
                          disabled={saving}
                          className="ml-3 inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title="Hand out support work">
        <form onSubmit={assign} className="grid sm:grid-cols-2 gap-3">
          <Field label="Support worker *">
            <select required value={form.workerId} onChange={(e) => setForm({ ...form, workerId: e.target.value })} className={inputCls}>
              <option value="">Select…</option>
              {helpers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
            {helpers.length === 0 && <p className="mt-1 text-xs text-amber-700">Nobody holds the {SUPPORT_ROLE} role yet. Add it under Workers.</p>}
          </Field>
          <Field label="Supporting operation *">
            <select value={form.operation} onChange={(e) => setForm({ ...form, operation: e.target.value })} className={inputCls}>
              {SUPPORT_OPERATIONS.map((operation) => <option key={operation} value={operation}>{operation}</option>)}
            </select>
          </Field>
          <Field label="Pieces handed over *"><input required type="number" min="1" max={chosenRemaining ?? undefined} value={form.quantityAssigned} onChange={(e) => setForm({ ...form, quantityAssigned: e.target.value })} className={inputCls} /></Field>
          <Field label="Agreed rate per piece (₦)"><input type="number" min="0" value={form.pieceRate} onChange={(e) => setForm({ ...form, pieceRate: e.target.value })} className={inputCls} /></Field>
          <Field label="From which production *" className="sm:col-span-2">
            <select required value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className={inputCls}>
              <option value="">Select production…</option>
              {eligibleSources.map((source) => {
                const id = source.kind === "SHARE" ? source.productionAllocationId : source.productionOperationId;
                return (
                  <option key={`${source.kind}:${id}`} value={`${source.kind === "SHARE" ? "share" : "stage"}:${id}`}>
                    {[
                      isWorker ? null : source.holder,
                      source.orderNumber && source.orderNumber !== "-" ? source.orderNumber : null,
                      source.garment,
                      source.variant,
                      source.stage ? String(source.stage).replaceAll("_", " ") : null,
                    ].filter(Boolean).join(" • ")} ({source.holding} pcs)
                  </option>
                );
              })}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              {chosenSource
                ? chosenRemaining !== null && chosenRemaining > 0
                  ? `${chosenRemaining} piece${chosenRemaining === 1 ? "" : "s"} of ${form.operation} still open on this work.`
                  : `Nothing more of ${form.operation} can be handed out on this work.`
                : "Choose the exact garment this help is for. The order, size, colour and stage come with it, and the pieces handed over can never exceed what is still open."}
            </p>
          </Field>
          <Field label="Notes" className="sm:col-span-2"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputCls} placeholder="e.g. Taping for the navy blazers" /></Field>
          {formErr && <p className="sm:col-span-2 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setAssignOpen(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Hand out work"}</Btn>
          </div>
        </form>
      </Modal>

      <Modal open={!!submitFor} onClose={() => setSubmitFor(null)} title={submitFor ? `Submit ${submitFor.operation} work` : ""}>
        <form onSubmit={submitWork} className="grid gap-3">
          <p className="text-xs text-slate-500 rounded-lg border border-matesther-100 bg-matesther-50 px-3 py-2">
            {submitFor?.quantityAssigned} pieces were handed to {submitFor?.supportWorker}; {submitFor?.quantitySubmitted} already returned
            {submitFor?.outstanding !== undefined ? `, ${submitFor.outstanding} still to settle` : ""}.
            Nothing is payable until the tailor inspects and approves it.
          </p>
          <Field label="Pieces completed *"><input required type="number" min="1" max={submitFor ? Math.max(1, submitFor.quantityAssigned - submitFor.quantitySubmitted + submitFor.pending) : undefined} value={submitQty} onChange={(e) => setSubmitQty(e.target.value)} className={inputCls} /></Field>
          {formErr && <p className="text-sm text-red-600">{formErr}</p>}
          <div className="flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setSubmitFor(null)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Submitting…" : "Submit for inspection"}</Btn>
          </div>
        </form>
      </Modal>

      {/* A pause and a cancellation both need a written reason, because both are
          questions somebody else has to answer later: why did the stage stop, and why
          was the hand-over withdrawn. The server refuses either without one. */}
      <Modal
        open={!!reasonFor}
        onClose={() => { setReasonFor(null); setReasonText(""); }}
        title={reasonFor?.action === "pause" ? "Pause this support work" : "Cancel this support work"}
      >
        <div className="grid gap-3">
          <p className="rounded-lg border border-matesther-100 bg-matesther-50 px-3 py-2 text-xs text-slate-600">
            {reasonFor?.action === "pause"
              ? `${reasonFor?.row?.supportWorker ?? "The helper"} stops work on ${reasonFor?.row?.quantityAssigned ?? 0} pieces of ${reasonFor?.row?.operation?.toLowerCase() ?? "support work"}. Production Control will show this stage as waiting on paused support, with your reason beside it.`
              : `${reasonFor?.row?.quantityAssigned ?? 0} pieces of ${reasonFor?.row?.operation?.toLowerCase() ?? "support work"} handed to ${reasonFor?.row?.supportWorker ?? "the helper"} will be withdrawn. This is only possible while nothing has been submitted; once work comes back it must be inspected, so the history stays intact.`}
          </p>
          <Field label={reasonFor?.action === "pause" ? "Why is the work being paused? *" : "Why is this being cancelled? *"}>
            <input
              required
              minLength={3}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              className={inputCls}
              placeholder={reasonFor?.action === "pause" ? "e.g. Sewing machine down until Thursday" : "e.g. Order changed, pieces no longer needed"}
            />
          </Field>
          {formErr && <p className="text-sm text-red-600" role="alert">{formErr}</p>}
          <div className="flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => { setReasonFor(null); setReasonText(""); }}>Keep working</Btn>
            <Btn
              type="button"
              disabled={saving || reasonText.trim().length < 3}
              onClick={() => reasonFor && lifecycle(reasonFor.row, reasonFor.action, reasonText.trim())}
            >
              {saving ? "Saving…" : reasonFor?.action === "pause" ? "Pause work" : "Cancel hand-over"}
            </Btn>
          </div>
        </div>
      </Modal>

      <Modal open={!!inspectFor} onClose={() => setInspectFor(null)} title={inspectFor ? `Inspect ${inspectFor.supportWorker}'s ${inspectFor.operation.toLowerCase()}` : ""}>
        <form onSubmit={inspect} className="grid sm:grid-cols-3 gap-3">
          <p className="sm:col-span-3 text-xs text-slate-500 rounded-lg border border-matesther-100 bg-matesther-50 px-3 py-2">
            {inspectFor?.pending} piece{inspectFor?.pending === 1 ? "" : "s"} awaiting inspection. Only approved pieces are paid, at {naira(inspectFor?.pieceRate ?? 0)} each.
            You cannot approve work you did yourself.
          </p>
          <Field label="Approved"><input type="number" min="0" value={inspectForm.quantityApproved} onChange={(e) => setInspectForm({ ...inspectForm, quantityApproved: e.target.value })} className={inputCls} /></Field>
          <Field label="Rework"><input type="number" min="0" value={inspectForm.quantityRework} onChange={(e) => setInspectForm({ ...inspectForm, quantityRework: e.target.value })} className={inputCls} /></Field>
          <Field label="Rejected"><input type="number" min="0" value={inspectForm.quantityRejected} onChange={(e) => setInspectForm({ ...inspectForm, quantityRejected: e.target.value })} className={inputCls} /></Field>
          <Field label="Reason (required for rework or rejection)" className="sm:col-span-3">
            <input value={inspectForm.notes} onChange={(e) => setInspectForm({ ...inspectForm, notes: e.target.value })} className={inputCls} placeholder="e.g. Two tapes puckered" />
          </Field>
          {formErr && <p className="sm:col-span-3 text-sm text-red-600">{formErr}</p>}
          <div className="sm:col-span-3 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setInspectFor(null)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Record inspection"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
