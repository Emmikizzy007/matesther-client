"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Phone, Trash2, Archive, RotateCcw } from "lucide-react";
import { Card, PageHeader, Badge, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira, fmtDate, stageLabel, WORKER_ROLES, staffCategories } from "@/lib/format";
import { useAuth } from "@/lib/auth";

export default function WorkersPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", phone: "", roles: ["Tailor"], department: "", jobTitle: "", paymentType: "PER_PIECE", paymentRate: "", status: "ACTIVE", isInspector: false });
  const [history, setHistory] = useState<any>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    setLoadError("");
    fetch(`/api/workers${showArchived ? "?showArchived=1" : ""}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load workers.");
        setRows(Array.isArray(data) ? data : []);
      })
      .catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Unable to load workers."))
      .finally(() => setLoading(false));
  }
  useEffect(load, [showArchived]);

  async function removeWorker(person: any) {
    const action = person.hasHistory ? "archive" : "permanently delete";
    if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} ${person.name}? ${person.hasHistory ? "Production and payroll history will remain available." : "This worker has no production or payroll history."}`)) return;
    try {
      const response = await fetch(`/api/workers?id=${person.id}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to remove this worker.");
      await load();
    } catch (cause) { alert(cause instanceof Error ? cause.message : "Unable to remove worker."); }
  }

  async function restoreWorker(person: any) {
    try {
      const response = await fetch("/api/workers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...person, status: "ACTIVE" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to restore this worker.");
      await load();
      alert("Worker restored. If their login was deactivated, reactivate it under Users.");
    } catch (cause) { alert(cause instanceof Error ? cause.message : "Unable to restore worker."); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.roles.length) { setErr("Choose at least one role for this person."); return; }
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/workers", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        // `specialty` is still sent so anything reading it keeps working; the
        // first chosen role is the primary one.
        body: JSON.stringify({ ...form, specialty: form.roles[0], id: editing?.id, paymentRate: Number(form.paymentRate) || 0 }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to save");
      setModal(false);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(id: number) {
    setHistoryLoading(true);
    setHistory({ name: "Loading…" });
    try {
      const d = await fetch(`/api/workers?id=${id}`, { cache: "no-store" }).then((r) => r.json());
      setHistory(d);
    } catch {
      setHistory(null);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Workers"
        subtitle="Cutters, tailors, buttonhole, button tacking, ironers and packers - who is doing what"
        action={<>
          <Btn variant="secondary" onClick={() => setShowArchived((current) => !current)}>{showArchived ? "Active only" : "Show archived"}</Btn>
          {isOwner && <Btn onClick={() => { setEditing(null); setForm({ name: "", phone: "", roles: ["Tailor"], department: "", jobTitle: "", paymentType: "PER_PIECE", paymentRate: "", status: "ACTIVE", isInspector: false }); setErr(""); setModal(true); }}>
            <Plus className="w-4 h-4" /> Add Worker
          </Btn>}
        </>}
      />
      <Card>
        {loading ? <Loading /> : loadError ? <div className="p-5 text-sm text-red-700">{loadError} <button onClick={load} className="font-semibold underline">Try again</button></div> : rows.length === 0 ? <EmptyState title={showArchived ? "No archived workers" : "No active workers"} /> : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Worker</th>
                  <th className="px-3 py-3">Roles</th>
                  {isOwner && <th className="px-3 py-3">Pay</th>}
                  <th className="px-3 py-3 text-right">Current Tasks</th>
                  <th className="px-3 py-3 text-right">Assigned</th>
                  <th className="px-3 py-3 text-right">Approved</th>
                  <th className="px-3 py-3 text-right">Rejected</th>
                  {isOwner && <th className="px-3 py-3 text-right">Earnings</th>}
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((w) => (
                  <tr key={w.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <p className="font-semibold">{w.name}</p>
                      <p className="text-xs text-slate-500 flex items-center gap-1"><Phone className="w-3 h-3" />{w.phone || "-"}</p>
                      {(w.jobTitle || w.department) && (
                        <p className="text-[11px] text-slate-400">{[w.jobTitle, w.department].filter(Boolean).join(" - ")}</p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span className="inline-flex flex-wrap gap-1">
                        {(Array.isArray(w.roles) && w.roles.length ? w.roles : [w.specialty]).map((role: string) => (
                          <span key={role} className="rounded-full border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">{role}</span>
                        ))}
                      </span>
                      <span className="mt-1 block text-[10px] text-slate-400">{staffCategories(Array.isArray(w.roles) && w.roles.length ? w.roles : [w.specialty]).join(" + ")}</span>
                      {w.isInspector && (
                        <span className="ml-1.5 inline-block text-[10px] font-bold bg-violet-100 text-violet-800 border border-violet-200 rounded-full px-1.5 py-0.5 align-middle">
                          Also inspects
                        </span>
                      )}
                    </td>
                    {isOwner && <td className="px-3 py-3 text-xs">
                      {w.paymentType.replace("_", " ")}<br />
                      <span className="font-semibold">{w.paymentType === "PER_PIECE" ? "Agreed per job" : naira(w.paymentRate)}</span>
                    </td>}
                    <td className="px-3 py-3 text-right font-bold">{w.currentTasks}</td>
                    <td className="px-3 py-3 text-right">{w.assigned.toLocaleString()}</td>
                    <td className="px-3 py-3 text-right text-matesther-700 font-semibold">{(w.approved ?? w.completed).toLocaleString()}</td>
                    <td className="px-3 py-3 text-right text-red-600">{w.rejected}</td>
                    {isOwner && <td className="px-3 py-3 text-right font-bold text-matesther-700">{naira(w.earnings)}</td>}
                    <td className="px-3 py-3"><Badge status={w.status} /></td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <button onClick={() => openHistory(w.id)} className="text-xs font-semibold text-matesther-700 hover:underline mr-3">History</button>
                      {isOwner && <>
                        <button title={`Edit ${w.name}`} aria-label={`Edit ${w.name}`} onClick={() => {
                          setEditing(w);
                          setForm({ name: w.name, phone: w.phone || "", roles: Array.isArray(w.roles) && w.roles.length ? w.roles : [w.specialty], department: w.department || "", jobTitle: w.jobTitle || "", paymentType: w.paymentType, paymentRate: String(w.paymentRate), status: w.status, isInspector: !!w.isInspector });
                          setErr(""); setModal(true);
                        }} className="p-1 text-slate-500 hover:text-matesther-700"><Pencil className="w-4 h-4" /></button>
                        {w.status === "ACTIVE" ? <button title={w.hasHistory ? `Archive ${w.name}` : `Delete ${w.name}`} aria-label={w.hasHistory ? `Archive ${w.name}` : `Delete ${w.name}`}
                          onClick={() => void removeWorker(w)} className="p-1 text-slate-500 hover:text-red-700">
                          {w.hasHistory ? <Archive className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                        </button> : <button title={`Restore ${w.name}`} aria-label={`Restore ${w.name}`} onClick={() => void restoreWorker(w)} className="p-1 text-slate-500 hover:text-matesther-700"><RotateCcw className="w-4 h-4" /></button>}
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? "Edit Worker" : "Add Worker"}>
        <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
          <Field label="Full name *" className="sm:col-span-2"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="e.g. Mrs. Aisha Bello" /></Field>
          <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputCls} placeholder="+234 ..." /></Field>
          <Field label="Roles * - pick every job this person does" className="sm:col-span-2">
            <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 p-2.5">
              {WORKER_ROLES.map((role) => {
                const on = form.roles.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setForm({ ...form, roles: on ? form.roles.filter((chosen) => chosen !== role) : [...form.roles, role] })}
                    className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${on ? "border-matesther-700 bg-matesther-700 text-white" : "border-slate-300 bg-white text-slate-600 hover:border-matesther-700"}`}
                  >
                    {role}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-slate-500">One person, many roles - add them once, then tick everything they do. Non-production staff such as Security, Sales or IT can be recorded here without a production specialty.</p>
          </Field>
          <Field label="Job title">
            <input value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} className={inputCls} placeholder="e.g. Security Guard, Sales Girl, Director" />
          </Field>
          <Field label="Department">
            <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputCls} placeholder="e.g. Security, Sales, IT, Management" />
          </Field>
          <Field label="Payment type">
            <select value={form.paymentType} onChange={(e) => setForm({ ...form, paymentType: e.target.value })} className={inputCls}>
              <option value="PER_PIECE">Per piece</option>
              <option value="DAILY">Daily</option>
              <option value="MONTHLY">Monthly</option>
            </select>
          </Field>
          {form.paymentType === "PER_PIECE" ? <p className="self-end rounded-lg border border-matesther-100 bg-matesther-50 p-2 text-xs text-matesther-800">Agree the price per garment when assigning each production job. This profile does not fix one price for all clothes.</p>
            : <Field label={form.paymentType === "MONTHLY" ? "Monthly salary (₦)" : "Daily rate (₦)"}><input type="number" min="0" value={form.paymentRate} onChange={(e) => setForm({ ...form, paymentRate: e.target.value })} className={inputCls} /></Field>}
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={!!form.isInspector} onChange={(e) => setForm({ ...form, isInspector: e.target.checked })} className="accent-matesther-700" />
            <span>
              Also inspects production work - <span className="text-slate-500">they'll appear in the Inspection Queue's “Inspectors on duty”</span>
            </span>
          </label>
          {editing && (
            <Field label="Status" className="sm:col-span-2">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={inputCls}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </Field>
          )}
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Worker"}</Btn>
          </div>
        </form>
      </Modal>

      <Modal open={!!history} onClose={() => setHistory(null)} title={history ? `${history.name} - production history` : ""} wide>
        {historyLoading ? (
          <Loading />
        ) : history && history.history ? (
          <div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-slate-50 rounded-lg p-3 text-center"><p className="text-xs text-slate-500">Assigned</p><p className="font-bold">{history.assigned}</p></div>
              <div className="bg-slate-50 rounded-lg p-3 text-center"><p className="text-xs text-slate-500">Completed</p><p className="font-bold text-matesther-700">{history.completed}</p></div>
              <div className="bg-slate-50 rounded-lg p-3 text-center"><p className="text-xs text-slate-500">Rejected</p><p className="font-bold text-red-600">{history.rejected}</p></div>
            </div>
            <div className="space-y-2 max-h-[50vh] overflow-y-auto slim-scroll">
              {history.history.map((h: any) => (
                <div key={h.id} className="border border-slate-200 rounded-lg p-3 text-sm flex flex-wrap items-center gap-2 justify-between">
                  <div>
                    <p className="font-semibold">{stageLabel(h.stage)} - {h.batchNumber}</p>
                    <p className="text-xs text-slate-500">
                      {isOwner
                        ? <Link href={`/orders/${h.orderId}`} className="text-matesther-700 hover:underline">{h.orderNumber}</Link>
                        : <span className="font-semibold text-matesther-700">{h.orderNumber}</span>} • {h.customer}
                    </p>
                  </div>
                  <div className="text-right text-xs">
                    <Badge status={h.status} />
                    <p className="text-slate-500 mt-1">Rcvd {h.quantityReceived} • Done {h.quantityCompleted} • Rej {h.quantityRejected}</p>
                    <p className="text-slate-400">{h.expectedCompletionDate ? `Expected ${fmtDate(h.expectedCompletionDate)}` : ""}</p>
                  </div>
                </div>
              ))}
              {history.history.length === 0 && <EmptyState title="No production records for this worker yet" />}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
