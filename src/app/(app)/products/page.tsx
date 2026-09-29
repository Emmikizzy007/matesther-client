"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil } from "lucide-react";
import { Card, PageHeader, Loading, EmptyState, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira } from "@/lib/format";

export default function ProductsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", category: "Shirts", sellingPrice: "", description: "" });
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    fetch("/api/products", { cache: "no-store" })
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
      const res = await fetch("/api/products", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, id: editing?.id, sellingPrice: Number(form.sellingPrice) || 0 }),
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

  return (
    <div>
      <PageHeader
        title="Products"
        subtitle="Uniform items Matesther offers schools - used when building orders"
        action={
          <Btn onClick={() => { setEditing(null); setForm({ name: "", category: "Shirts", sellingPrice: "", description: "" }); setErr(""); setModal(true); }}>
            <Plus className="w-4 h-4" /> Add Product
          </Btn>
        }
      />
      <Card>
        {loading ? <Loading /> : rows.length === 0 ? <EmptyState title="No products yet" /> : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Product</th>
                  <th className="px-3 py-3">Category</th>
                  <th className="px-3 py-3">Description</th>
                  <th className="px-3 py-3 text-right">Selling Price</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-semibold">{p.name}</td>
                    <td className="px-3 py-3">{p.category || "-"}</td>
                    <td className="px-3 py-3 text-xs text-slate-500">{p.description || ""}</td>
                    <td className="px-3 py-3 text-right font-bold">{naira(p.sellingPrice)}</td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => { setEditing(p); setForm({ name: p.name, category: p.category || "Shirts", sellingPrice: String(p.sellingPrice), description: p.description || "" }); setErr(""); setModal(true); }}
                        className="p-1.5 text-slate-500 hover:text-matesther-700"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? "Edit Product" : "Add Product"}>
        <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
          <Field label="Product name *" className="sm:col-span-2">
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="e.g. Secondary School Shirt" />
          </Field>
          <Field label="Category">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls}>
              {["Shirts", "Trousers", "Skirts", "Shorts", "Blazers", "Sportswear", "Other"].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Selling price (₦)"><input type="number" min="0" value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} className={inputCls} /></Field>
          <Field label="Description" className="sm:col-span-2">
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} placeholder="e.g. White shirt with monogram" />
          </Field>
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Product"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
