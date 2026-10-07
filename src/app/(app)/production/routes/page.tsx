"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Factory, Plus, Trash2 } from "lucide-react";
import { Btn, Card, EmptyState, Field, Loading, PageHeader, inputCls } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { PRODUCTION_METHODS, STAGES, STAGE_ROLES, methodLabel, stageLabel } from "@/lib/format";

/**
 * PRODUCTION ROUTES.
 *
 * A route is the ordered list of stages ONE garment actually passes through. It may
 * include all eight, skip stages, start later or end earlier - but it never invents
 * a stage, so roles, labels, inspection and payroll all keep working.
 *
 * THE IMPORTANT PROPERTY, stated on screen because it is what makes editing safe:
 * a batch freezes the route it was created with. Editing or retiring a route here
 * changes only batches created afterwards; nothing already in production moves.
 */

type RouteStage = { stage: string; method: string; roleRequired: string | null };
type Route = {
  id: number; name: string; productId: number | null; productName: string | null;
  isDefault: boolean; isActive: boolean; notes: string | null; stages: RouteStage[];
  /**
   * Whether a NEW batch would actually follow this route, computed on the server by the
   * same rule `resolveRoute` uses. The screen shows this rather than inferring it from
   * the DEFAULT badge, because the two are not the same question: a route can be saved
   * against a garment and still not be the one used.
   */
  usedForNewBatches?: boolean;
};
type Product = { id: number; name: string };

const BUILTIN: RouteStage[] = STAGES.map((stage) => ({ stage, method: "INTERNAL", roleRequired: null }));

export default function ProductionRoutesPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";
  const [routes, setRoutes] = useState<Route[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  /** "" = every route; "none" = organisation-level; otherwise a product id as a string. */
  const [productFilter, setProductFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Route | "new" | null>(null);
  const [draft, setDraft] = useState({ name: "", productId: "", isDefault: false, notes: "", stages: BUILTIN });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function load() {
    // No leading setLoading(true): `loading` already starts true, so the first
    // paint shows the spinner without a synchronous setState inside the effect.
    // Reloads after a save keep their button-level busy indicator.
    try {
      const [routeResponse, productResponse] = await Promise.all([
        fetch("/api/routes", { cache: "no-store" }),
        fetch("/api/products", { cache: "no-store" }),
      ]);
      const [routeData, productData] = await Promise.all([routeResponse.json(), productResponse.json()]);
      if (!routeResponse.ok) throw new Error(routeData.error || "Could not load production routes.");
      setRoutes(Array.isArray(routeData) ? routeData : []);
      setProducts(Array.isArray(productData) ? productData : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load production routes.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function open(route: Route | "new") {
    setError(""); setSaved("");
    setEditing(route);
    setDraft(route === "new"
      ? { name: "", productId: "", isDefault: false, notes: "", stages: BUILTIN.map((stage) => ({ ...stage })) }
      : {
          name: route.name,
          productId: route.productId ? String(route.productId) : "",
          isDefault: route.isDefault,
          notes: route.notes ?? "",
          stages: route.stages.length ? route.stages.map((stage) => ({ ...stage })) : BUILTIN.map((stage) => ({ ...stage })),
        });
  }

  function toggleStage(stage: string) {
    setDraft((current) => ({
      ...current,
      stages: current.stages.some((entry) => entry.stage === stage)
        ? current.stages.filter((entry) => entry.stage !== stage)
        : [...current.stages, { stage, method: "INTERNAL", roleRequired: null }],
    }));
  }

  function moveStage(stage: string, direction: -1 | 1) {
    setDraft((current) => {
      const stages = [...current.stages];
      const from = stages.findIndex((entry) => entry.stage === stage);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= stages.length) return current;
      [stages[from], stages[to]] = [stages[to], stages[from]];
      return { ...current, stages };
    });
  }

  function patchStage(stage: string, patch: Partial<RouteStage>) {
    setDraft((current) => ({
      ...current,
      stages: current.stages.map((entry) => (entry.stage === stage ? { ...entry, ...patch } : entry)),
    }));
  }

  async function save() {
    setBusy(true); setError(""); setSaved("");
    try {
      if (!draft.name.trim()) throw new Error("Give this route a name, for example \"Polo - no cutting\".");
      if (!draft.stages.length) throw new Error("A route needs at least one stage.");
      const readyMadeNotFirst = draft.stages.findIndex((stage) => stage.method === "READY_MADE");
      if (readyMadeNotFirst > 0)
        throw new Error(`${stageLabel(draft.stages[readyMadeNotFirst].stage)} cannot be a ready-made purchase part-way through a route. A bought-in finished garment is where production starts - put it first.`);
      const body = {
        ...(editing !== "new" && editing ? { id: (editing as Route).id } : {}),
        name: draft.name.trim(),
        productId: draft.productId ? Number(draft.productId) : null,
        isDefault: draft.isDefault,
        notes: draft.notes.trim() || null,
        stages: draft.stages.map((stage) => ({ stage: stage.stage, method: stage.method, roleRequired: stage.roleRequired || null })),
      };
      const response = await fetch("/api/routes", {
        method: editing === "new" || !editing ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save this route.");
      setSaved(`"${result.name ?? draft.name}" saved. Batches already in production keep the route they were created with.`);
      setEditing(null);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this route."); }
    finally { setBusy(false); }
  }

  async function retire(route: Route) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/routes", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: route.id, isActive: false }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not retire this route.");
      setSaved(`"${route.name}" retired. Batches already following it are unaffected.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not retire this route."); }
    finally { setBusy(false); }
  }

  /**
   * The routes the current filter shows. Filtering a short array in the browser is right
   * here: the list is already fetched whole for the editor, and a round trip per dropdown
   * change would be slower than the filter it replaces.
   */
  const visibleRoutes = productFilter === ""
    ? routes
    : productFilter === "none"
      ? routes.filter((route) => route.productId === null)
      : routes.filter((route) => String(route.productId) === productFilter);

  return <div className="mx-auto max-w-5xl">
    <PageHeader
      title="Production Routes"
      subtitle="Which stages a garment actually follows, in what order, and how each one is produced. Not every garment needs all eight."
      action={<Link href="/production/assign" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-matesther-600"><ArrowLeft className="h-4 w-4" /> Assign production</Link>}
    />

    <Card className="mb-4 border-matesther-200 bg-matesther-50/60 p-4">
      <p className="flex items-center gap-2 text-sm font-bold text-matesther-900"><Factory className="h-4 w-4" /> Editing a route never rewrites production</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        Each batch freezes the route it was created with - the stages it follows are stored on the batch itself. Changing,
        re-ordering or retiring a route here affects only batches created afterwards. A polo already in production keeps the
        route it started on, and a garment is never reported as stuck at a stage its own route does not have.
      </p>
    </Card>

    {error && !editing && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {saved && !editing && <div role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{saved}</div>}

    {loading ? <Card><Loading label="Loading production routes..." /></Card> : editing ? (
      <Card className="p-4 sm:p-6">
        <p className="mb-4 text-sm font-bold text-slate-900">{editing === "new" ? "New production route" : `Edit "${(editing as Route).name}"`}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Route name *"><input className={inputCls} value={draft.name} placeholder="e.g. Polo - no cutting" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
          <Field label="Applies to">
            <select className={inputCls} value={draft.productId} onChange={(event) => setDraft({ ...draft, productId: event.target.value })}>
              <option value="">Every garment (organization default)</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </Field>
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs text-slate-600">
          <input type="checkbox" className="mt-0.5" checked={draft.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} />
          <span>Use this route automatically for new batches{draft.productId ? " of this garment" : " when a garment has no route of its own"}.</span>
        </label>

        <p className="mb-2 mt-5 text-[11px] font-bold uppercase tracking-wide text-slate-500">Stages, in the order this garment follows them</p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {STAGES.map((stage) => {
            const chosen = draft.stages.some((entry) => entry.stage === stage);
            return <button key={stage} type="button" onClick={() => toggleStage(stage)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${chosen ? "border-matesther-700 bg-matesther-700 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
              {chosen ? "✓ " : ""}{stageLabel(stage)}
            </button>;
          })}
        </div>

        {draft.stages.length === 0
          ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">Pick at least one stage. Leaving stages out is the point: a garment that is bought in cut-and-sew has no Cutting stage.</p>
          : <ol className="space-y-2">
              {draft.stages.map((stage, index) => (
                <li key={stage.stage} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">{index + 1}</span>
                    <span className="text-sm font-semibold text-slate-800">{stageLabel(stage.stage)}</span>
                    <div className="ml-auto flex gap-1">
                      <button type="button" aria-label={`Move ${stageLabel(stage.stage)} earlier`} disabled={index === 0}
                        onClick={() => moveStage(stage.stage, -1)} className="rounded border border-slate-200 px-2 py-0.5 text-xs disabled:opacity-30">↑</button>
                      <button type="button" aria-label={`Move ${stageLabel(stage.stage)} later`} disabled={index === draft.stages.length - 1}
                        onClick={() => moveStage(stage.stage, 1)} className="rounded border border-slate-200 px-2 py-0.5 text-xs disabled:opacity-30">↓</button>
                    </div>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Field label="How it is produced">
                      <select className={inputCls} value={stage.method} onChange={(event) => patchStage(stage.stage, { method: event.target.value })}>
                        {PRODUCTION_METHODS.map((method) => <option key={method} value={method}>{methodLabel(method)}</option>)}
                      </select>
                    </Field>
                    <Field label={`Role required${STAGE_ROLES[stage.stage as keyof typeof STAGE_ROLES] ? ` (default: ${STAGE_ROLES[stage.stage as keyof typeof STAGE_ROLES]})` : ""}`}>
                      <input className={inputCls} value={stage.roleRequired ?? ""} placeholder={STAGE_ROLES[stage.stage as keyof typeof STAGE_ROLES] ?? "e.g. Packer"}
                        onChange={(event) => patchStage(stage.stage, { roleRequired: event.target.value })} />
                    </Field>
                  </div>
                  {stage.method === "MACHINE" && (
                    <p className="mt-2 rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
                      This is Matesther equipment, so an operator is assigned and submits work as usual - only the cost is
                      treated differently. If this machine is really a service bought in from someone else, set the method
                      to External processing instead.
                    </p>
                  )}
                  {stage.method === "READY_MADE" && index === 0 && (
                    <p className="mt-2 rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
                      Bought in finished: record the purchase under Ready-made receipts on the production board. No worker is
                      assigned and no piece rate is created, so a purchase is never counted as tailor labour.
                    </p>
                  )}
                  {(stage.method === "OUTSOURCED" || stage.method === "VENDOR_PROCESSING") && (
                    <p className="mt-2 rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
                      Work leaves the factory: send garments out and record what comes back under External work. Only what
                      Matesther ACCEPTS on return moves on to the next stage.
                    </p>
                  )}
                </li>
              ))}
            </ol>}

        <Field label="Notes"><textarea className={`${inputCls} mt-4`} rows={2} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Why this garment follows this route" /></Field>
        {error && <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Btn variant="secondary" onClick={() => { setEditing(null); setError(""); }}>Cancel</Btn>
          <Btn onClick={() => void save()} disabled={busy || !isOwner}>{busy ? "Saving…" : "Save route"}</Btn>
        </div>
        {!isOwner && <p className="mt-2 text-xs text-amber-700">Only the Owner can define production routes.</p>}
      </Card>
    ) : (
      <div className="space-y-3">
        {isOwner && <div className="flex justify-end"><Btn onClick={() => open("new")}><Plus className="h-4 w-4" /> New route</Btn></div>}
        {/*
          FILTER BY GARMENT.

          The list is flat and sorted with organisation-level routes first, because a NULL
          product sorts before any id. With a handful of garments that reads as "the screen
          only shows organisation defaults" even when every product route is present - which
          is how this defect was first reported. Filtering to one garment answers the real
          question ("what does THIS uniform follow?") without scrolling.
        */}
        {routes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-semibold text-slate-600" htmlFor="route-product-filter">Show routes for</label>
            <select
              id="route-product-filter"
              className={`${inputCls} w-auto min-w-[14rem]`}
              value={productFilter}
              onChange={(event) => setProductFilter(event.target.value)}
            >
              <option value="">Every garment ({routes.length})</option>
              <option value="none">Organisation-wide defaults ({routes.filter((route) => route.productId === null).length})</option>
              {products.map((product) => (
                <option key={product.id} value={String(product.id)}>
                  {product.name} ({routes.filter((route) => route.productId === product.id).length})
                </option>
              ))}
            </select>
          </div>
        )}
        {routes.length > 0 && visibleRoutes.length === 0 && (
          <Card><EmptyState title="No routes for that garment" hint="It follows the organisation default if one is flagged, otherwise the Matesther standard eight-stage route. Assign it a route of its own to shorten it, skip a stage, or send one stage out." /></Card>
        )}
        {routes.length === 0 ? (
          <Card><EmptyState title="No routes defined yet" hint="Every garment currently follows the Matesther standard eight-stage route. Define a route to shorten it, skip a stage, or send one stage out." /></Card>
        ) : visibleRoutes.map((route) => (
          <Card key={route.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900">
                  {route.name}
                  {/* IN USE is the server's own answer, and is the badge that matters: it says
                      a new batch of this garment really will follow these stages. DEFAULT is
                      kept beside it because it is the flag that produced that answer. */}
                  {route.usedForNewBatches && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">IN USE FOR NEW BATCHES</span>}
                  {route.isDefault && !route.usedForNewBatches && <span className="ml-2 rounded-full bg-matesther-100 px-2 py-0.5 text-[10px] font-bold text-matesther-800">DEFAULT</span>}
                  {!route.isActive && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">RETIRED</span>}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">{route.productName ? `For ${route.productName}` : "For any garment"} • {route.stages.length} stage{route.stages.length === 1 ? "" : "s"}</p>
                {/* A garment route that is NOT in use is a configuration problem, so it is
                    named rather than left to be guessed at: either another of the garment's
                    routes is flagged as its default, or two are competing and neither is. */}
                {route.productId !== null && route.isActive && !route.usedForNewBatches && (
                  <p className="mt-1 text-xs font-semibold text-amber-700">
                    Not used for new batches of {route.productName ?? "this garment"} —{" "}
                    {routes.some((other) => other.productId === route.productId && other.isActive && other.isDefault && other.id !== route.id)
                      ? `${routes.find((other) => other.productId === route.productId && other.isActive && other.isDefault)?.name ?? "another route"} is flagged as this garment's default.`
                      : routes.filter((other) => other.productId === route.productId && other.isActive).length > 1
                        ? "several of this garment's routes are active and none is flagged as its default, so none can be chosen automatically. Flag one."
                        : "it is not flagged as the default."}
                  </p>
                )}
                {route.notes && <p className="mt-1 text-xs text-slate-600">{route.notes}</p>}
              </div>
              {isOwner && <div className="flex gap-2">
                <Btn variant="secondary" onClick={() => open(route)}>Edit</Btn>
                {route.isActive && <Btn variant="secondary" onClick={() => void retire(route)} disabled={busy}>Retire</Btn>}
              </div>}
            </div>
            <ol className="mt-3 flex flex-wrap items-center gap-1.5">
              {route.stages.map((stage, index) => (
                <li key={stage.stage} className="flex items-center gap-1.5">
                  <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs">
                    <span className="font-semibold text-slate-800">{stageLabel(stage.stage)}</span>
                    <span className="ml-1.5 text-[10px] font-semibold text-slate-500">{methodLabel(stage.method)}</span>
                    {stage.roleRequired && <span className="ml-1.5 text-[10px] text-slate-400">needs {stage.roleRequired}</span>}
                  </span>
                  {index < route.stages.length - 1 && <span className="text-xs text-slate-300">→</span>}
                </li>
              ))}
            </ol>
          </Card>
        ))}
        <Card className="p-4">
          <p className="text-sm font-bold text-slate-900">Matesther standard eight-stage route</p>
          <p className="mt-0.5 text-xs text-slate-500">Built in. Used for any garment with no route of its own, and for every batch created before routes existed.</p>
          <ol className="mt-3 flex flex-wrap items-center gap-1.5">
            {BUILTIN.map((stage, index) => (
              <li key={stage.stage} className="flex items-center gap-1.5">
                <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800">{stageLabel(stage.stage)}</span>
                {index < BUILTIN.length - 1 && <span className="text-xs text-slate-300">→</span>}
              </li>
            ))}
          </ol>
        </Card>
        <p className="flex items-center gap-1.5 text-xs text-slate-500"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> A route only ever selects and orders the real Matesther stages, so roles, inspection and pay keep working on every one of them.</p>
        <p className="flex items-center gap-1.5 text-xs text-slate-400"><Trash2 className="h-3.5 w-3.5" /> Retiring is preferred to deleting: batches already produced from a route keep the record of what they followed.</p>
      </div>
    )}
  </div>;
}
