"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Phone } from "lucide-react";
import { Card, PageHeader, Badge, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira, fmtDate, stageLabel, WORKER_SPECIALTIES } from "@/lib/format";
import { useAuth } from "@/lib/auth";

export default function WorkersPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", phone: "", specialty: "Tailor", paymentType: "PER_PIECE", paymentRate: "", status: "ACTIVE", isInspector: false });
  const [history, setHistory] = useState<any>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    fetch("/api/workers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/workers", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, id: editing?.id, paymentRate: Number(form.paymentRate) || 0 }),
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
        action={isOwner ? (
          <Btn onClick={() => { setEditing(null); setForm({ name: "", phone: "", specialty: "Tailor", paymentType: "PER_PIECE", paymentRate: "", status: "ACTIVE", isInspector: false }); setErr(""); setModal(true); }}>
            <Plus className="w-4 h-4" /> Add Worker
          </Btn>
        ) : undefined}
      />
      <Card>
        {loading ? <Loading /> : rows.length === 0 ? <EmptyState title="No workers" /> : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Worker</th>
                  <th className="px-3 py-3">Specialty</th>
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
                    </td>
                    <td className="px-3 py-3">
                      {w.specialty}
                      {w.isInspector && (
                        <span className="ml-1.5 inline-block text-[10px] font-bold bg-violet-100 text-violet-800 border border-violet-200 rounded-full px-1.5 py-0.5 align-middle">
                          Also inspects
                        </span>
                      )}
                    </td>
                    {isOwner && <td className="px-3 py-3 text-xs">
                      {w.paymentType.replace("_", " ")}<br />
                      <span className="font-semibold">{naira(w.paymentRate)}</span>
                    </td>}
                    <td className="px-3 py-3 text-right font-bold">{w.currentTasks}</td>
                    <td className="px-3 py-3 text-right">{w.assigned.toLocaleString()}</td>
                    <td className="px-3 py-3 text-right text-matesther-700 font-semibold">{(w.approved ?? w.completed).toLocaleString()}</td>
                    <td className="px-3 py-3 text-right text-red-600">{w.rejected}</td>
                    {isOwner && <td className="px-3 py-3 text-right font-bold text-matesther-700">{naira(w.earnings)}</td>}
                    <td className="px-3 py-3"><Badge status={w.status} /></td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <button onClick={() => openHistory(w.id)} className="text-xs font-semibold text-matesther-700 hover:underline mr-3">History</button>
                      {isOwner && <button
                        onClick={() => {
                          setEditing(w);
                          setForm({ name: w.name, phone: w.phone || "", specialty: w.specialty, paymentType: w.paymentType, paymentRate: String(w.paymentRate), status: w.status, isInspector: !!w.isInspector });
                          setErr("");
                          setModal(true);
                        }}
                        className="p-1 text-slate-500 hover:text-matesther-700"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>}
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
          <Field label="Specialty">
            <select value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} className={inputCls}>
              {WORKER_SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Payment type">
            <select value={form.paymentType} onChange={(e) => setForm({ ...form, paymentType: e.target.value })} className={inputCls}>
              <option value="PER_PIECE">Per piece</option>
              <option value="DAILY">Daily</option>
              <option value="MONTHLY">Monthly</option>
            </select>
          </Field>
          <Field label="Payment rate (₦)"><input type="number" min="0" value={form.paymentRate} onChange={(e) => setForm({ ...form, paymentRate: e.target.value })} className={inputCls} /></Field>
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
