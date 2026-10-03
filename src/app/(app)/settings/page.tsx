"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Card, CardHeader, PageHeader, Loading, Modal, Field, inputCls, Btn, Badge } from "@/components/ui";
import { naira, stageLabel, STAGES as STAGE_CODES } from "@/lib/format";
import { useAuth, roleLabel } from "@/lib/auth";
import { BrandLogo } from "@/components/BrandLogo";

export default function SettingsPage() {
  const { user } = useAuth();
  const [org, setOrg] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgForm, setOrgForm] = useState({ name: "", phone: "", email: "", address: "" });
  const [msg, setMsg] = useState("");
  const [prodModal, setProdModal] = useState(false);
  const [prodForm, setProdForm] = useState({ id: null as number | null, name: "", description: "", category: "Shirts", sellingPrice: "" });
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoConfigured, setLogoConfigured] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoMessage, setLogoMessage] = useState("");

  async function uploadLogo() {
    if (!logoFile) return;
    setLogoBusy(true);
    setLogoMessage("");
    try {
      const body = new FormData();
      body.set("logo", logoFile);
      const response = await fetch("/api/branding/logo", { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Couldn't save your logo.");
      setLogoConfigured(true);
      setLogoVersion(Date.now());
      setLogoFile(null);
      setLogoMessage("Original image saved. Refresh this page to update the sidebar and browser icon.");
    } catch (error) {
      setLogoMessage(error instanceof Error ? error.message : "Could not upload logo.");
    } finally {
      setLogoBusy(false);
    }
  }

  function load() {
    setLoading(true);
    Promise.all([
      fetch("/api/org", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/products", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/users", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([o, p, u]) => {
        setOrg(o.org);
        setLogoConfigured(!!o.org?.logoConfigured);
        setUsers(Array.isArray(u) ? u : o.users ?? []);
        setProducts(Array.isArray(p) ? p : []);
        if (o.org) setOrgForm({ name: o.org.name, phone: o.org.phone || "", email: o.org.email || "", address: o.org.address || "" });
      })
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function saveOrg(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    const res = await fetch("/api/org", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(orgForm) });
    setSaving(false);
    if (res.ok) {
      setMsg("Business profile saved.");
      load();
    } else setMsg("Failed to save.");
  }

  async function saveProduct(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/products", {
        method: prodForm.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...prodForm, sellingPrice: Number(prodForm.sellingPrice) || 0 }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to save");
      setProdModal(false);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Derived from the one stage list in lib/format rather than being a fifth
  // hand-typed copy of it, so this page cannot drift from the pipeline the
  // production routes actually run.
  const STAGES = STAGE_CODES.map(stageLabel);

  return (
    <div>
      <PageHeader title="Settings" subtitle="Business profile, uniform catalogue, users and workflow" />

      {loading ? (
        <Card><Loading /></Card>
      ) : (
        <div className="grid xl:grid-cols-2 gap-4">
          <div className="space-y-4">
            <Card>
              <CardHeader title="Business Profile" subtitle="Shown across the Matesther ERP" />
              <form onSubmit={saveOrg} className="p-5 grid sm:grid-cols-2 gap-3">
                <Field label="Business name"><input value={orgForm.name} onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })} className={inputCls} /></Field>
                <Field label="Phone"><input value={orgForm.phone} onChange={(e) => setOrgForm({ ...orgForm, phone: e.target.value })} className={inputCls} /></Field>
                <Field label="Email"><input value={orgForm.email} onChange={(e) => setOrgForm({ ...orgForm, email: e.target.value })} className={inputCls} /></Field>
                <Field label="Address"><input value={orgForm.address} onChange={(e) => setOrgForm({ ...orgForm, address: e.target.value })} className={inputCls} /></Field>
                <div className="sm:col-span-2 flex items-center justify-between">
                  <p className="text-xs text-matesther-700">{msg}</p>
                  <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Profile"}</Btn>
                </div>
              </form>
            </Card>

            <Card>
              <CardHeader title="Original company logo" subtitle="Upload the actual file; the app does not redraw or replace your artwork." />
              <div className="space-y-3 p-5">
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-matesther-950 p-3">
                    <BrandLogo key={logoVersion} className="h-20 w-20 rounded-lg" version={logoVersion} />
                  </div>
                  <div className="text-sm">
                    <p className="font-semibold text-slate-900">{logoConfigured ? "Logo saved in Matesther's database" : "Original logo not uploaded yet"}</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-500">
                      Save the exact image from your chat to your device, then select that file below.
                      The original pixels are used in the header and receipts; phone icons only scale it to fit.
                    </p>
                  </div>
                </div>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)}
                  className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-matesther-100 file:px-3 file:py-2 file:font-semibold file:text-matesther-900"
                  aria-label="Select original Matesther company logo"
                />
                {logoMessage && <p role="status" className="text-xs text-matesther-800">{logoMessage}</p>}
                <Btn onClick={uploadLogo} disabled={!logoFile || logoBusy}>
                  {logoBusy ? "Uploading…" : logoConfigured ? "Replace with original image" : "Upload original logo"}
                </Btn>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Users & Roles"
                subtitle="Staff logins - create accounts, set passwords, activate / deactivate"
                action={<Link href="/users" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-matesther-700 hover:bg-slate-50">Manage staff accounts</Link>}
              />
              <div className="divide-y divide-slate-100">
                {users.map((u: any) => (
                  <div key={u.id} className="px-5 py-3 flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-semibold truncate">
                        {u.name} {user?.email === u.email && <span className="text-xs text-matesther-700">(you)</span>}
                      </p>
                      <p className="text-xs text-slate-500 truncate">{u.email} • {u.phone || "-"}</p>
                      <p className="text-[11px] mt-0.5">
                        <span className="font-semibold text-slate-600">
                          {u.role === "OWNER" ? "Owner" : u.role === "PRODUCTION_MANAGER" ? "Production Manager" : "Worker"}
                        </span>
                        <span className="text-slate-400"> • {u.hasPassword ? "password set" : "no password yet"}</span>
                      </p>
                      {u.role === "WORKER" && <p className="mt-0.5 text-[11px] text-slate-500">Production jobs are managed under Workers.</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge status={u.status === "ACTIVE" ? "COMPLETED" : "CANCELLED"} />
                      <Link href="/users" className="text-xs font-semibold text-matesther-700 hover:underline">Manage</Link>
                    </div>
                  </div>
                ))}
                {users.length === 0 && <p className="p-5 text-sm text-slate-500">No staff accounts.</p>}
              </div>
              <div className="p-5 text-xs text-slate-500 border-t border-slate-100">
                <p><span className="font-semibold">Owner</span> - full access to everything.</p>
                <p><span className="font-semibold">Production Manager</span> - orders, production, materials, workers.</p>
                <p><span className="font-semibold">Worker</span> - assigned production tasks. {user && <span className="font-semibold">You are signed in as {roleLabel(user.role)}.</span>}</p>
              </div>
            </Card>

            <Card>
              <CardHeader title="Matesther Production Workflow" subtitle="Fixed 8-stage flow for every batch" />
              <div className="p-5 flex flex-wrap items-center gap-2">
                {STAGES.map((s, i) => (
                  <span key={s} className="flex items-center gap-2">
                    <span className="text-xs font-bold bg-matesther-800 text-white rounded-lg px-3 py-1.5">{i + 1}. {s}</span>
                    {i < STAGES.length - 1 && <span className="text-slate-300 font-bold">→</span>}
                  </span>
                ))}
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Uniform Catalogue"
              subtitle="Products offered to schools - used when creating orders"
              action={<Btn variant="secondary" onClick={() => { setProdForm({ id: null, name: "", description: "", category: "Shirts", sellingPrice: "" }); setErr(""); setProdModal(true); }}><Plus className="w-4 h-4" /> Add</Btn>}
            />
            <div className="divide-y divide-slate-100">
              {products.map((p) => (
                <div key={p.id} className="px-5 py-3 flex items-center justify-between text-sm">
                  <div>
                    <p className="font-semibold">{p.name}</p>
                    <p className="text-xs text-slate-500">{p.category || "-"}{p.description ? ` • ${p.description}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="font-bold">{naira(p.sellingPrice)}</p>
                    <button
                      onClick={() => { setProdForm({ id: p.id, name: p.name, description: p.description || "", category: p.category || "Shirts", sellingPrice: String(p.sellingPrice) }); setErr(""); setProdModal(true); }}
                      className="text-xs font-semibold text-matesther-700 hover:underline"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              ))}
              {products.length === 0 && <p className="p-5 text-sm text-slate-500">No products yet.</p>}
            </div>
          </Card>
        </div>
      )}

      <Modal open={prodModal} onClose={() => setProdModal(false)} title={prodForm.id ? "Edit Product" : "Add Uniform Product"}>
        <form onSubmit={saveProduct} className="grid sm:grid-cols-2 gap-3">
          <Field label="Product name *" className="sm:col-span-2"><input required value={prodForm.name} onChange={(e) => setProdForm({ ...prodForm, name: e.target.value })} className={inputCls} placeholder="e.g. Secondary School Shirt" /></Field>
          <Field label="Category">
            <select value={prodForm.category} onChange={(e) => setProdForm({ ...prodForm, category: e.target.value })} className={inputCls}>
              {["Shirts", "Trousers", "Skirts", "Shorts", "Blazers", "Sportswear", "Other"].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Selling price (₦)"><input type="number" min="0" value={prodForm.sellingPrice} onChange={(e) => setProdForm({ ...prodForm, sellingPrice: e.target.value })} className={inputCls} /></Field>
          <Field label="Description" className="sm:col-span-2"><input value={prodForm.description} onChange={(e) => setProdForm({ ...prodForm, description: e.target.value })} className={inputCls} placeholder="e.g. White shirt with monogram" /></Field>
          {err && <p className="sm:col-span-2 text-sm text-red-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setProdModal(false)}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? "Saving…" : "Save Product"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
