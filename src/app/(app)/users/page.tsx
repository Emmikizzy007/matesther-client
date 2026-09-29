"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Card, PageHeader, Badge, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function UsersPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "PRODUCTION_MANAGER", phone: "", status: "ACTIVE" });
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    fetch("/api/users", { cache: "no-store" })
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
      const body: any = {
        id: editing?.id,
        name: form.name,
        email: form.email,
        role: form.role,
        phone: form.phone,
        status: form.status,
      };
      if (form.password) body.password = form.password;
      const res = await fetch("/api/users", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  async function del(id: number, name: string) {
    if (!confirm(`Delete ${name}'s account? They will no longer be able to sign in.`)) return;
    const res = await fetch(`/api/users?id=${id}`, { method: "DELETE" });
    const d = await res.json();
    if (!res.ok) alert(d.error);
    else load();
  }

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Staff logins - the Owner has every Project-Manager function built in, plus full business control"
        action={
          <Btn onClick={() => { setEditing(null); setForm({ name: "", email: "", password: "", role: "PRODUCTION_MANAGER", phone: "", status: "ACTIVE" }); setErr(""); setModal(true); }}>
            <Plus className="w-4 h-4" /> Add Staff
          </Btn>
        }
      />

      <Card className="mb-4 p-4 text-xs text-slate-600 bg-matesther-50/60">
        <p className="font-bold text-matesther-800 mb-1">Permission hierarchy</p>
        <p><span className="font-semibold">Owner</span> - everything: business, money, production, inspection, users.</p>
        <p><span className="font-semibold">Project Manager</span> - production supervision &amp; inspection only. No revenue, profit, expenses or payment balances.</p>
        <p><span className="font-semibold">Worker</span> - their own jobs, journal, earnings and profile only.</p>
      </Card>

      <Card>
        {loading ? <Loading /> : rows.length === 0 ? <EmptyState title="No staff accounts" /> : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-3 py-3">Email (login)</th>
                  <th className="px-3 py-3">Role</th>
                  <th className="px-3 py-3">Phone</th>
                  <th className="px-3 py-3">Password</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-semibold">
                      {u.name} {user?.email === u.email && <span className="text-xs text-matesther-700">(you)</span>}
                    </td>
                    <td className="px-3 py-3">{u.email}</td>
                    <td className="px-3 py-3">{u.role.replace("_", " ")}</td>
                    <td className="px-3 py-3 text-xs">{u.phone || "-"}</td>
                    <td className="px-3 py-3 text-xs">{u.hasPassword ? "Set" : <span className="text-red-600 font-semibold">None</span>}</td>
                    <td className="px-3 py-3"><Badge status={u.status === "ACTIVE" ? "COMPLETED" : "CANCELLED"} /></td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => { setEditing(u); setForm({ name: u.name, email: u.email, password: "", role: u.role, phone: u.phone || "", status: u.status }); setErr(""); setModal(true); }}
                        className="text-xs font-semibold text-matesther-700 hover:underline mr-3"
                      >
                        Manage
                      </button>
                      {user?.role === "OWNER" && u.email !== user?.email && (
                        <button onClick={() => del(u.id, u.name)} className="p-1 text-slate-400 hover:text-red-700">
                          <Trash2 className="w-4 h-4" />
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

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? `Manage - ${editing.name}` : "Add Staff Account"}>
        <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
          <Field label="Full name *"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></Field>
          <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputCls} /></Field>
          <Field label="Email (login) *" className="sm:col-span-2">
            <input type="email" required disabled={!!editing} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={`${inputCls} disabled:bg-slate-100`} />
          </Field>
          <Field label="Role">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={inputCls}>
              <option value="OWNER">Owner / Admin</option>
              <option value="PRODUCTION_MANAGER">Project Manager</option>
              <option value="WORKER">Worker</option>
            </select>
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={inputCls}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Deactivated</option>
            </select>
          </Field>
          <Field label={editing ? "New password (blank = keep current)" : "Password (min 6 chars) *"} className="sm:col-span-2">
            <input type="password" required={!editing} minLength={6} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={inputCls} placeholder="••••••" />
          </Field>
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save Changes" : "Create Account"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
