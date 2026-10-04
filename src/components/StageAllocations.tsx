"use client";

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import { Btn, Field, inputCls } from "@/components/ui";
import { personHoldsRole } from "@/lib/format";

/**
 * SPLIT ONE STAGE ACROSS SEVERAL WORKERS.
 *
 * The concrete case: 100 navy size-10 polos at SEWING, worked 40 / 35 / 25 by three
 * tailors. That is ONE stage with three allocations, not three batches - so the
 * variant, the route and the order's allocation ceiling all stay intact.
 *
 * This component only asks for what the server will accept. Every limit shown here
 * is also enforced server-side against the movement ledger, so the numbers cannot be
 * talked past by editing a request: the shares may never sum to more than the stage
 * holds, a share may never be reduced below what that worker already submitted, and
 * a reassignment moves only unworked quantity so approved work - and the pay for it -
 * stays with the person who earned it.
 */

type Share = {
  id: number; workerId: number; workerName: string; pieceRate: number | null;
  quantityAllocated: number; quantitySubmitted: number; quantityApproved: number;
  quantityRework: number; quantityRejected: number; status: string; reason: string | null;
  assignedByName: string | null; outstanding: number; unjudged: number; live: boolean;
  stageHolds: number; stageAllocated: number; stageFree: number;
};
type Person = { id: number; name: string; specialty: string; roles?: string[]; status: string; paymentType: string };

export function StageAllocations({ operation, workers, requiredRole, onChanged }: {
  /** The stage being split. */
  operation: { id: number; stage: string; method: string; quantityReceived: number; workerId: number | null } | null;
  workers: Person[];
  /** The role this stage needs; the picker offers only people who hold it. */
  requiredRole: string | null;
  /** Called after any change so the parent can reload its own figures. */
  onChanged?: () => void;
}) {
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [workerId, setWorkerId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [pieceRate, setPieceRate] = useState("");
  const [moving, setMoving] = useState<Share | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [moveRate, setMoveRate] = useState("");
  const [moveReason, setMoveReason] = useState("");
  const [resizing, setResizing] = useState<Share | null>(null);
  const [resizeTo, setResizeTo] = useState("");
  const [resizeReason, setResizeReason] = useState("");

  const load = useCallback(async () => {
    if (!operation) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/allocations?operationId=${operation.id}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data)) throw new Error(data?.error || "Could not load this stage's allocations.");
      setShares(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this stage's allocations.");
    } finally { setLoading(false); }
  }, [operation]);
  useEffect(() => { void load(); }, [load]);

  if (!operation) return null;
  const external = ["OUTSOURCED", "VENDOR_PROCESSING", "READY_MADE"].includes(operation.method);
  const live = shares.filter((share) => share.live);
  const closed = shares.filter((share) => !share.live);
  const holds = shares[0]?.stageHolds ?? operation.quantityReceived ?? 0;
  const allocated = live.reduce((sum, share) => sum + share.quantityAllocated, 0);
  const free = Math.max(0, holds - allocated);
  const chosen = workers.find((person) => String(person.id) === workerId);
  const eligible = workers.filter((person) =>
    person.status === "ACTIVE" && (!requiredRole || personHoldsRole(person, requiredRole)) &&
    !live.some((share) => share.workerId === person.id));

  async function send(url: string, body: unknown, method: "POST" | "PUT") {
    setBusy(true); setError("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "That did not save.");
      await load();
      onChanged?.();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
      return false;
    } finally { setBusy(false); }
  }

  return (
    <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-white p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
        <Users className="h-3.5 w-3.5" /> Who is working this stage
      </p>

      {external ? (
        <p className="mt-2 rounded-md bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900">
          This stage is not worked by Matesther people, so it is not split between workers. Record it under
          External Work &amp; Ready-made: a vendor and what comes back, or a purchase and what is accepted on arrival.
        </p>
      ) : (
        <>
          <p className="mt-1.5 text-[11px] text-slate-500">
            {holds} garment{holds === 1 ? "" : "s"} at this stage • <strong>{allocated}</strong> allocated
            • <strong className={free ? "text-amber-700" : "text-emerald-700"}>{free}</strong> still to allocate.
            The shares can never add up to more than the stage holds, and what it holds comes from what the previous
            stage approved.
          </p>

          {loading ? <p className="mt-2 text-[11px] text-slate-400">Loading…</p> : live.length === 0 ? (
            <p className="mt-2 rounded-md bg-slate-50 p-2.5 text-[11px] text-slate-600">
              Nobody has been given a share of this stage yet.
              {operation.workerId ? " It is currently assigned to one worker as a whole; splitting it here does not move the work they have already submitted - that stays theirs." : ""}
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {live.map((share) => (
                <li key={share.id} className="rounded-md border border-slate-200 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-800">
                      {share.workerName}
                      {share.pieceRate !== null && <span className="ml-1.5 font-normal text-slate-500">₦{Number(share.pieceRate).toLocaleString("en-NG")} per approved piece</span>}
                    </p>
                    <div className="flex gap-1">
                      <button type="button" className="rounded border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-matesther-600"
                        onClick={() => { setResizing(share); setResizeTo(String(share.quantityAllocated)); setResizeReason(""); }}>Change qty</button>
                      <button type="button" className="rounded border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-matesther-600"
                        disabled={share.outstanding < 1}
                        onClick={() => { setMoving(share); setMoveTo(""); setMoveRate(share.pieceRate === null ? "" : String(share.pieceRate)); setMoveReason(""); }}>
                        Hand over{share.outstanding > 0 ? ` ${share.outstanding}` : ""}
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-slate-500">
                    <span>Allocated <strong className="text-slate-700">{share.quantityAllocated}</strong></span>
                    <span>Submitted <strong className="text-slate-700">{share.quantitySubmitted}</strong></span>
                    <span>Approved <strong className="text-emerald-700">{share.quantityApproved}</strong></span>
                    {share.quantityRework > 0 && <span>Rework <strong className="text-amber-700">{share.quantityRework}</strong></span>}
                    {share.quantityRejected > 0 && <span>Rejected <strong className="text-red-700">{share.quantityRejected}</strong></span>}
                    <span>Still to do <strong className="text-slate-700">{share.outstanding}</strong></span>
                    {share.unjudged > 0 && <span>Awaiting judgement <strong className="text-violet-700">{share.unjudged}</strong></span>}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {closed.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-slate-500">
                {closed.length} closed share{closed.length === 1 ? "" : "s"} (kept as the audit trail)
              </summary>
              <ul className="mt-1.5 space-y-1">
                {closed.map((share) => (
                  <li key={share.id} className="rounded-md bg-slate-50 p-2 text-[10px] text-slate-500">
                    <strong className="text-slate-700">{share.workerName}</strong> • {share.status.toLowerCase()} •
                    kept {share.quantityAllocated} (submitted {share.quantitySubmitted}, approved {share.quantityApproved})
                    {share.assignedByName ? ` • moved by ${share.assignedByName}` : ""}
                    {share.reason ? <span className="block mt-0.5 italic">{share.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {free > 0 && (
            <form className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-4"
              onSubmit={async (event) => {
                event.preventDefault();
                const ok = await send("/api/allocations", {
                  operationId: operation.id, workerId: Number(workerId), quantity: Number(quantity),
                  pieceRate: pieceRate === "" ? null : Number(pieceRate),
                }, "POST");
                if (ok) { setWorkerId(""); setQuantity(""); setPieceRate(""); }
              }}>
              <Field label={`Give work to${requiredRole ? ` a ${requiredRole}` : ""}`} className="sm:col-span-2">
                <select className={inputCls} required value={workerId}
                  onChange={(event) => { setWorkerId(event.target.value); setQuantity(String(free)); setPieceRate(""); }}>
                  <option value="">Choose a worker</option>
                  {eligible.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
                {requiredRole && eligible.length === 0 && (
                  <p className="mt-1 text-[10px] text-amber-700">
                    Every active {requiredRole} already holds a share of this stage.
                  </p>
                )}
              </Field>
              <Field label="Garments *">
                <input className={inputCls} type="number" min="1" max={free} step="1" required value={quantity}
                  onChange={(event) => setQuantity(event.target.value)} />
              </Field>
              {chosen?.paymentType === "PER_PIECE" ? (
                <Field label="Agreed ₦ per approved piece *">
                  <input className={inputCls} type="number" min="1" step="1" required value={pieceRate}
                    onChange={(event) => setPieceRate(event.target.value)} />
                </Field>
              ) : (
                <div className="self-end"><Btn type="submit" disabled={busy || !workerId || !quantity}>{busy ? "Saving…" : "Allocate"}</Btn></div>
              )}
              {chosen?.paymentType === "PER_PIECE" && (
                <div className="self-end sm:col-span-4"><Btn type="submit" disabled={busy || !workerId || !quantity || !pieceRate}>{busy ? "Saving…" : "Allocate"}</Btn></div>
              )}
            </form>
          )}

          {error && <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">{error}</p>}
        </>
      )}

      {/* Hand the unworked remainder to somebody else. */}
      {moving && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-bold text-amber-900">
            Hand {moving.outstanding} unworked garment{moving.outstanding === 1 ? "" : "s"} from {moving.workerName} to somebody else
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
            Only work not yet submitted moves. The {moving.quantitySubmitted} {moving.workerName} already submitted stays
            theirs, along with every approval it earns and the pay for it. Their closed share is kept beside the new one
            with your reason.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="To *">
              <select className={inputCls} required value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
                <option value="">Choose a worker</option>
                {workers.filter((person) => person.status === "ACTIVE" && person.id !== moving.workerId &&
                  (!requiredRole || personHoldsRole(person, requiredRole)) && !live.some((share) => share.workerId === person.id))
                  .map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </Field>
            <Field label="Their agreed ₦ per approved piece">
              <input className={inputCls} type="number" min="1" step="1" value={moveRate} onChange={(event) => setMoveRate(event.target.value)} />
            </Field>
          </div>
          <Field label="Why *"><input className={inputCls} required value={moveReason} onChange={(event) => setMoveReason(event.target.value)} placeholder="e.g. On leave for the rest of the week" /></Field>
          <div className="mt-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setMoving(null)}>Cancel</Btn>
            <Btn disabled={busy || !moveTo || moveReason.trim().length < 5}
              onClick={async () => {
                const ok = await send("/api/allocations", {
                  id: moving.id, toWorkerId: Number(moveTo), pieceRate: moveRate === "" ? null : Number(moveRate), reason: moveReason.trim(),
                }, "PUT");
                if (ok) setMoving(null);
              }}>{busy ? "Saving…" : "Hand over"}</Btn>
          </div>
        </div>
      )}

      {/* Change how many garments one share holds. */}
      {resizing && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-bold text-slate-800">Change the share held by {resizing.workerName}</p>
          <p className="mt-1 text-[11px] text-slate-600">
            Between the {resizing.quantitySubmitted} they have already submitted and {holds - (allocated - resizing.quantityAllocated)} in total.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="Garments *"><input className={inputCls} type="number" min={resizing.quantitySubmitted} max={holds - (allocated - resizing.quantityAllocated)} step="1" value={resizeTo} onChange={(event) => setResizeTo(event.target.value)} /></Field>
            <Field label="Why *"><input className={inputCls} required value={resizeReason} onChange={(event) => setResizeReason(event.target.value)} placeholder="e.g. Fewer bundles released to this line" /></Field>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setResizing(null)}>Cancel</Btn>
            <Btn disabled={busy || resizeReason.trim().length < 5}
              onClick={async () => {
                const ok = await send("/api/allocations", { id: resizing.id, quantity: Number(resizeTo), reason: resizeReason.trim() }, "PUT");
                if (ok) setResizing(null);
              }}>{busy ? "Saving…" : "Save share"}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
