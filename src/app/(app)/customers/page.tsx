"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Search } from "lucide-react";
import { Card, PageHeader, Badge, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira, fmtDate, CUSTOMER_TYPES } from "@/lib/format";

const empty = { name: "", type: "SCHOOL", contactPerson: "", phone: "", email: "", address: "" };

export default function CustomersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState<any>(empty);
  const [editing, setEditing] = useState<any>(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    fetch("/api/customers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  function openNew() {
    setEditing(null);
    setForm(empty);
    setErr("");
    setModal(true);
  }
  function openEdit(c: any) {
    setEditing(c);
    setForm({ ...c });
    setErr("");
    setModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const res = await fetch(editing ? `/api/customers/${editing.id}` : "/api/customers", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
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

  async function del(id: number) {
    if (!confirm("Delete this customer?")) return;
    const res = await fetch(`/api/customers/${id}`, { method: "DELETE" });
    const d = await res.json();
    if (!res.ok) alert(d.error);
    else load();
  }

  const filtered = rows.filter(
    (c) =>
      c.name.toLowerCase().includes(q.toLowerCase()) ||
      (c.contactPerson || "").toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Schools, companies and organisations that order uniforms from Matesther"
        action={
          <Btn onClick={openNew}>
            <Plus className="w-4 h-4" /> Add Customer
          </Btn>
        }
      />
      <Card className="mb-4 p-3">
        <div className="relative max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers…" className={`${inputCls} pl-9`} />
        </div>
      </Card>
      <Card>
        {loading ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <EmptyState title="No customers found" hint="Add your first school or organisation." />
        ) : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[800px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Customer</th>
                  <th className="px-3 py-3">Type</th>
                  <th className="px-3 py-3">Contact</th>
                  <th className="px-3 py-3 text-right">Orders</th>
                  <th className="px-3 py-3 text-right">Total Ordered</th>
                  <th className="px-3 py-3 text-right">Outstanding</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <p className="font-semibold">{c.name}</p>
                      <p className="text-xs text-slate-500">{c.address || c.email || "-"}</p>
                    </td>
                    <td className="px-3 py-3"><Badge status={c.type === "SCHOOL" ? "COMPLETED" : "PENDING"} /><span className="sr-only">{c.type}</span></td>
                    <td className="px-3 py-3">
                      <p className="text-[13px]">{c.contactPerson || "-"}</p>
                      <p className="text-xs text-slate-500">{c.phone || ""}</p>
                    </td>
                    <td className="px-3 py-3 text-right font-semibold">{c.orderCount}</td>
                    <td className="px-3 py-3 text-right">{naira(c.totalOrdered)}</td>
                    <td className="px-3 py-3 text-right font-semibold text-amber-700">{naira(c.outstanding)}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <button onClick={() => openEdit(c)} className="p-1.5 text-slate-500 hover:text-matesther-700"><Pencil className="w-4 h-4" /></button>
                      <button onClick={() => del(c.id)} className="p-1.5 text-slate-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? "Edit Customer" : "Add Customer"}>
        <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
          <Field label="Customer name * (e.g. Osun Model College)" className="sm:col-span-2">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className={inputCls} placeholder="School / company name" />
          </Field>
          <Field label="Type">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={inputCls}>
              {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Contact person">
            <input value={form.contactPerson || ""} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} className={inputCls} placeholder="e.g. Bursar" />
          </Field>
          <Field label="Phone">
            <input value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputCls} placeholder="+234 ..." />
          </Field>
          <Field label="Email">
            <input value={form.email || ""} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls} placeholder="email@example.com" />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <input value={form.address || ""} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputCls} placeholder="School address" />
          </Field>
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
            <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Customer"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
