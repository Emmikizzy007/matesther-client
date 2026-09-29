"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import { Card, PageHeader, Badge, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { useAuth } from "@/lib/auth";

type Account = {
  id: number; name: string; email: string; role: string; status: string;
  phone: string | null; workerName: string | null; workerId: number | null; hasPassword: boolean;
};
type FactoryProfile = { id: number; name: string; specialty: string; status: string };
type AccountForm = { name: string; email: string; password: string; role: string; phone: string; status: string; workerId: string };
const emptyForm = (): AccountForm => ({ name: "", email: "", password: "", role: "PRODUCTION_MANAGER", phone: "", status: "ACTIVE", workerId: "" });

export default function UsersPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [factoryWorkers, setFactoryWorkers] = useState<FactoryProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [form, setForm] = useState<AccountForm>(emptyForm);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setLoadError("");
    try {
      const [response, workersResponse] = await Promise.all([
        fetch("/api/users", { cache: "no-store" }),
        fetch("/api/workers", { cache: "no-store" }),
      ]);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to load staff accounts.");
      const profiles = workersResponse.ok ? await workersResponse.json() : [];
      setAccounts(Array.isArray(result) ? result : []);
      setFactoryWorkers(Array.isArray(profiles) ? profiles : []);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Unable to load staff accounts.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function openNew() { setEditing(null); setForm(emptyForm()); setError(""); setModal(true); }
  function openEdit(account: Account) {
    setEditing(account);
    setForm({ name: account.name, email: account.email, password: "", role: account.role, phone: account.phone ?? "", status: account.status, workerId: account.workerId ? String(account.workerId) : "" });
    setError(""); setModal(true);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await fetch("/api/users", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, id: editing?.id, workerId: form.role === "PRODUCTION_MANAGER" ? form.workerId || null : undefined }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save staff account.");
      setModal(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save staff account."); }
    finally { setSaving(false); }
  }
  async function remove(account: Account) {
    if (!confirm(`Delete ${account.name}'s login? Their production and payroll records will remain.`)) return;
    try {
      const response = await fetch(`/api/users?id=${account.id}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not delete this account.");
      await load();
    } catch (cause) { alert(cause instanceof Error ? cause.message : "Could not delete this account."); }
  }

  return <div>
    <PageHeader title="Users" subtitle="Manage Matesther staff logins and permissions." action={<Btn onClick={openNew}><Plus className="h-4 w-4" /> Add Staff</Btn>} />
    <Card>
      {loading ? <Loading label="Loading staff accounts..." /> : loadError ?
        <div className="p-5 text-sm text-red-700">{loadError} <button onClick={() => void load()} className="font-semibold underline">Try again</button></div> :
        accounts.length === 0 ? <EmptyState title="No staff accounts yet" /> :
        <div className="overflow-x-auto slim-scroll"><table className="w-full min-w-[790px] text-sm">
          <thead><tr className="border-b border-slate-100 text-left text-[11px] uppercase text-slate-500">
            <th className="px-5 py-3">Name</th><th className="px-3 py-3">Sign-in email</th>
            <th className="px-3 py-3">Role</th><th className="px-3 py-3">Phone</th>
            <th className="px-3 py-3">Status</th><th className="px-3 py-3 text-right">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">{accounts.map((account) =>
            <tr key={account.id} className="hover:bg-slate-50">
              <td className="px-5 py-3 font-semibold">{account.name}{account.email === user?.email && <span className="ml-1 text-xs text-matesther-700">(you)</span>}</td>
              <td className="px-3 py-3">{account.email}</td>
              <td className="px-3 py-3"><p>{account.role === "OWNER" ? "Owner" : account.role === "PRODUCTION_MANAGER" ? "Project Manager" : "Worker"}</p>
                {account.role === "WORKER" && <p className={`mt-0.5 text-xs ${account.workerName ? "text-emerald-700" : "text-amber-700"}`}>
                  {account.workerName ? `Workers record: ${account.workerName}` : <>No matching Workers record yet. <Link href="/workers" className="font-semibold underline">Add worker</Link></>}
                </p>}
                {account.role === "PRODUCTION_MANAGER" && <p className="mt-0.5 text-xs text-matesther-700">{account.workerId ? `Also works as ${account.workerName || "factory staff"}` : "Supervisor only"}</p>}
              </td>
              <td className="px-3 py-3 text-xs">{account.phone || "-"}</td>
              <td className="px-3 py-3"><Badge status={account.status} /></td>
              <td className="whitespace-nowrap px-3 py-3 text-right">
                <button onClick={() => openEdit(account)} className="mr-3 text-xs font-semibold text-matesther-700 hover:underline">Manage</button>
                {account.email !== user?.email && <button onClick={() => void remove(account)} aria-label={`Delete ${account.name}'s login`} className="p-1 text-slate-400 hover:text-red-700"><Trash2 className="h-4 w-4" /></button>}
              </td>
            </tr>)}</tbody>
        </table></div>}
    </Card>
    <Modal open={modal} onClose={() => setModal(false)} title={editing ? `Manage ${editing.name}` : "Add Staff Account"}>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name *"><input required className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Phone"><input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Email address *" className="sm:col-span-2"><input type="email" required disabled={!!editing} className={`${inputCls} disabled:bg-slate-100`} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Role"><select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="OWNER">Owner / Admin</option><option value="PRODUCTION_MANAGER">Project Manager</option><option value="WORKER">Worker</option>
        </select></Field>
        <Field label="Status"><select className={inputCls} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option>
        </select></Field>
        {form.role === "WORKER" && <p className="sm:col-span-2 text-xs text-slate-500">Add this person on the <strong>Workers</strong> page with the same full name to show their jobs and earnings. You can create this login now or add their Workers record first.</p>}
        {form.role === "PRODUCTION_MANAGER" && <div className="sm:col-span-2">
          <Field label="Also works in the factory (optional)">
            <select value={form.workerId} onChange={(event) => setForm({ ...form, workerId: event.target.value })} className={inputCls}>
              <option value="">Supervision only</option>
              {factoryWorkers.filter((profile) => profile.status === "ACTIVE" && !accounts.some((account) => account.workerId === profile.id && account.id !== editing?.id)).map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name} ({profile.specialty})</option>
              ))}
            </select>
          </Field>
          <p className="mt-1 text-xs text-slate-500">A cutter-inspector uses this same login to supervise production and view their own assigned work and earnings. If they already have a Worker login, manage that account and change its role to Project Manager.</p>
        </div>}
        <Field label={editing ? "New password (optional)" : "Password (at least 6 characters) *"} className="sm:col-span-2"><input type="password" required={!editing} minLength={6} className={inputCls} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        {error && <p className="sm:col-span-2 text-sm text-red-700" role="alert">{error}</p>}
        <div className="flex justify-end gap-2 sm:col-span-2"><Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn><Btn type="submit" disabled={saving}>{saving ? "Saving..." : editing ? "Save changes" : "Create account"}</Btn></div>
      </form>
    </Modal>
  </div>;
}
