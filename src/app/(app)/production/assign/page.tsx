"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CheckCircle2, Factory, Plus, Scissors } from "lucide-react";
import { Btn, Card, Field, Loading, PageHeader, inputCls } from "@/components/ui";
import { fmtDate, methodLabel, personHoldsRole, stageLabel, STAGES, STAGE_ROLES, PRODUCTION_METHODS } from "@/lib/format";

/**
 * ASSIGN PRODUCTION - generic and stage-aware.
 *
 * This screen used to have two hardcoded boxes, "Cutting assignment" and "Sewing
 * assignment", and told the operator that "each batch has the eight Matesther
 * production stages". Neither was true for a polo bought in cut-and-sew, a
 * ready-made cardigan, or a garment whose monogramming goes out to a vendor.
 *
 * It now works from three things the server tells it:
 *   1. the exact VARIANTS on the order line (item + size + colour + quantity), with
 *      what is still available to allocate on each;
 *   2. the ROUTE this garment will follow - the product's default, another saved
 *      route, or a one-off built here - so the stages listed are the stages that
 *      will actually exist;
 *   3. the ROLE each of those stages needs, so each worker dropdown offers only
 *      people who hold it.
 *
 * Nothing here decides a quantity. The allocation ceilings, the route freeze and
 * the role checks are all enforced server-side; this screen only shows what the
 * server will accept.
 */

type Variant = { id: number; size: string | null; color: string | null; quantity: number; allocated: number; available: number; label: string };
type ProductionOrder = {
  id: number; orderNumber: string; customer: string; dueDate: string | null; status: string;
  items: {
    id: number; name: string; productId: number | null; quantity: number;
    variants: Variant[]; sizes: { size: string | null; quantity: number }[];
    assigned: { batchId: number; size: string | null; color: string | null; quantity: number; route: string | null }[];
    /** The route a NEW batch of this garment would follow, resolved server-side. */
    defaultRouteId: number | null;
    defaultRouteName: string | null;
    /** True when that route is the organisation-wide default rather than this garment's own. */
    defaultRouteIsGeneric: boolean;
  }[];
};
type Worker = { id: number; name: string; specialty: string; roles?: string[]; paymentType: string; status: string };
type RouteStage = { position?: number; stage: string; method: string; roleRequired: string | null };
type Route = { id: number; name: string; productId: number | null; productName: string | null; isDefault: boolean; isActive: boolean; stages: RouteStage[] };

type Form = {
  orderId: string; itemId: string; variantId: string; quantity: string;
  routeChoice: string; expectedCompletionDate: string;
};
const newForm = (): Form => ({ orderId: "", itemId: "", variantId: "", quantity: "", routeChoice: "", expectedCompletionDate: "" });

/** The route a stage list falls back to when nothing is defined for a garment. */
const BUILTIN: RouteStage[] = STAGES.map((stage) => ({ stage, method: "INTERNAL", roleRequired: null }));

export default function AssignProductionPage() {
  // `useSearchParams` reads the query string during render, which opts this route into
  // dynamic rendering; Next.js requires it to sit inside a Suspense boundary so the
  // shell can paint first. The fallback is the same spinner the page already shows while
  // it loads its catalogue, so nothing new appears.
  return (
    <Suspense fallback={<div className="mx-auto max-w-4xl"><Card><Loading label="Loading assignment options..." /></Card></div>}>
      <AssignProduction />
    </Suspense>
  );
}

function AssignProduction() {
  const searchParams = useSearchParams();
  /**
   * The order this screen was opened FOR, when it was opened from a school's order page.
   *
   * It is a preselection, not an authorisation: the value comes from a query string
   * anybody can type, and everything it does is decide which row of the catalogue is
   * chosen in the dropdown. The catalogue itself is fetched from
   * GET /api/production-orders, which scopes to the caller's organisation and refuses a
   * completed or cancelled order, so an id that is not this caller's, or not open for
   * production, simply is not in the list and nothing gets preselected.
   */
  const requestedOrderId = (searchParams.get("orderId") ?? "").trim();
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [canAssignCutting, setCanAssignCutting] = useState(false);
  const [form, setForm] = useState<Form>(newForm());
  // Per-stage choices: which worker, at what rate, with what method override.
  const [stageChoices, setStageChoices] = useState<Record<string, { workerId: string; pieceRate: string; method: string }>>({});
  const [customStages, setCustomStages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function load() {
    setLoading(true);
    try {
      /* ---- the catalogue ----
       *
       * The FULL open-order catalogue is fetched even when this screen was opened for one
       * particular order, and that is deliberate. Preselecting an order must not cost the
       * operator the ability to change their mind: arriving here from a school's order page
       * and finding a dropdown with one entry in it is a worse screen than the one that made
       * them hunt through the list in the first place.
       *
       * What makes that affordable is that the endpoint is now scoped in SQL - the caller's
       * own organisation and only orders still open for production - rather than reading
       * every order, customer, item, product, variant, batch and route in the database and
       * filtering in JavaScript, which is what it did before. `?id=` remains available for a
       * caller that genuinely wants one order, and is what the tests use.
       */
      const [orderResponse, workerResponse, accessResponse, routeResponse] = await Promise.all([
        fetch("/api/production-orders", { cache: "no-store" }),
        fetch("/api/workers?view=slim", { cache: "no-store" }),
        fetch("/api/production-access", { cache: "no-store" }),
        // Only routes still in use are offered, and the filter is applied in SQL rather
        // than to a full list in the browser.
        fetch("/api/routes?activeOnly=1", { cache: "no-store" }),
      ]);
      const [orderData, workerData, accessData, routeData] = await Promise.all([
        orderResponse.json(), workerResponse.json(), accessResponse.json(), routeResponse.json(),
      ]);
      if (!orderResponse.ok || !workerResponse.ok || !accessResponse.ok)
        throw new Error(orderData.error || workerData.error || accessData.error || "Could not load assignment options.");
      const cuttingAllowed = accessData.canAssignCutting === true;
      setCanAssignCutting(cuttingAllowed);
      const catalogue: ProductionOrder[] = Array.isArray(orderData) ? orderData : [];
      setOrders(catalogue);
      setWorkers(Array.isArray(workerData) ? workerData : []);
      setRoutes(Array.isArray(routeData) ? routeData.filter((route: Route) => route.isActive) : []);
      // Preselect the order the caller came from, and its due date as the target, so
      // "Start Production" lands here with the work already chosen rather than with a
      // dropdown to hunt through. Silently does nothing when the order is not in the
      // catalogue - not this caller's, or not open for production - because guessing a
      // different order would be worse than asking.
      if (/^\d+$/.test(requestedOrderId)) {
        const wanted = catalogue.find((entry) => String(entry.id) === requestedOrderId);
        if (wanted) {
          setForm({ ...newForm(), orderId: String(wanted.id), expectedCompletionDate: wanted.dueDate ?? "" });
          if (wanted.items.length === 1) setForm((current) => ({ ...current, itemId: String(wanted.items[0].id) }));
        } else {
          setError("That order is not available for production - it may be completed, cancelled, or not yours to see. Choose another below.");
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load assignment options.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [requestedOrderId]);

  const order = orders.find((record) => String(record.id) === form.orderId);
  const item = order?.items.find((record) => String(record.id) === form.itemId);
  const variant = item?.variants.find((entry) => String(entry.id) === form.variantId);

  /**
   * The stages this batch will actually get, in the order it will follow them.
   * Computed inline rather than memoised: it filters a handful of short arrays, and
   * a manual useMemo here is one the React Compiler reports it cannot preserve.
   */
  const plannedStages: RouteStage[] = (() => {
    if (form.routeChoice === "custom") {
      return customStages.length ? customStages.map((stage) => ({ stage, method: "INTERNAL", roleRequired: null })) : BUILTIN;
    }
    if (form.routeChoice && form.routeChoice !== "default") {
      const chosen = routes.find((route) => String(route.id) === form.routeChoice);
      if (chosen?.stages.length) return chosen.stages;
    }
    // "default": the product's own default route when it has one, else the
    // organization's generic default, else the eight stages Matesther has always run.
    const productDefault = item?.defaultRouteId ? routes.find((route) => route.id === item.defaultRouteId) : null;
    if (productDefault?.stages.length) return productDefault.stages;
    const genericDefault = routes.find((route) => !route.productId && route.isDefault);
    if (genericDefault?.stages.length) return genericDefault.stages;
    return BUILTIN;
  })();

  const roleFor = (stage: RouteStage) => stage.roleRequired ?? STAGE_ROLES[stage.stage as keyof typeof STAGE_ROLES] ?? null;
  const choiceFor = (stage: string) => stageChoices[stage] ?? { workerId: "", pieceRate: "", method: "" };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setSaved("");
    if (!order || !item) return setError("Select a school order and uniform garment.");
    const quantity = Number(form.quantity);
    const ceiling = variant ? variant.available : Math.max(0, item.quantity - item.assigned.reduce((sum, batch) => sum + batch.quantity, 0));
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > ceiling)
      return setError(ceiling ? `Choose between 1 and ${ceiling} garments still available to allocate.` : "Every garment on this order line has already been allocated to production.");
    if (item.variants.length && !variant)
      return setError("Choose the exact size and colour being allocated.");

    const assignments = plannedStages
      .map((stage) => {
        const choice = choiceFor(stage.stage);
        return choice.workerId ? { stage: stage.stage, workerId: Number(choice.workerId), pieceRate: choice.pieceRate === "" ? null : Number(choice.pieceRate) } : null;
      })
      .filter((entry): entry is { stage: string; workerId: number; pieceRate: number | null } => !!entry);

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        orderId: order.id, orderItemId: item.id, quantity,
        orderVariantId: variant?.id ?? null,
        // `size`/`color` are still sent so the batch snapshot is right even for an
        // order whose variants were recorded before colour existed.
        size: variant?.size ?? "", color: variant?.color ?? "",
        assignments,
        expectedCompletionDate: form.expectedCompletionDate || null,
      };
      if (form.routeChoice === "custom") body.stages = customStages.map((stage) => ({ stage }));
      else if (form.routeChoice && form.routeChoice !== "default") body.routeId = Number(form.routeChoice);
      else if (item.defaultRouteId) body.routeId = item.defaultRouteId;

      const response = await fetch("/api/batches", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not start production.");
      setSaved(`${result.batchNumber} created for ${order.customer}: ${quantity} × ${item.name}${variant ? ` (${variant.label})` : ""}, following ${plannedStages.length} stage${plannedStages.length === 1 ? "" : "s"}.`);
      setForm((current) => ({ ...newForm(), orderId: current.orderId, itemId: current.itemId }));
      setStageChoices({});
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start production."); }
    finally { setSaving(false); }
  }

  return <div className="mx-auto max-w-4xl">
    <PageHeader
      title="Assign Production"
      subtitle="Allocate an exact garment - item, size, colour and quantity - to a route, and agree the pay for each stage of it."
      action={<Link href="/production/routes" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-matesther-600"><Factory className="h-4 w-4" /> Production routes</Link>}
    />
    {loading ? <Card><Loading label="Loading school orders, variants and routes..." /></Card> :
      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 bg-matesther-50/70 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-bold text-matesther-900"><Scissors className="h-4 w-4" /> New production allocation</p>
          <p className="mt-1 text-xs text-slate-600">
            A batch follows ONE route, which may be all eight stages or fewer. Only approved pieces move to the next
            stage of that route - never to a stage the route does not have.
          </p>
        </div>
        <form onSubmit={submit} className="space-y-5 p-4 sm:p-6">
          {/* Arriving from a school's order page, the order is already chosen - so say so,
              rather than leaving the operator to notice a dropdown was pre-filled. */}
          {/^\d+$/.test(requestedOrderId) && order && (
            <p className="flex flex-wrap items-center gap-2 rounded-lg border border-matesther-200 bg-matesther-50 px-3 py-2 text-xs text-matesther-900">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                Opened for <strong>{order.customer}</strong> · {order.orderNumber}
                {order.dueDate ? ` · due ${order.dueDate}` : ""}
              </span>
              <Link href={`/orders/${order.id}`} className="ml-auto font-semibold text-matesther-700 hover:underline">
                Back to this order
              </Link>
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="1. School order *"><select className={inputCls} required value={form.orderId} onChange={(event) => {
              const chosen = orders.find((entry) => String(entry.id) === event.target.value);
              setForm({ ...newForm(), orderId: event.target.value, expectedCompletionDate: chosen?.dueDate ?? "" });
              setStageChoices({}); setSaved("");
            }}><option value="">Choose school order</option>
              {orders.map((record) => <option key={record.id} value={record.id}>{record.customer} | {record.orderNumber}</option>)}
            </select></Field>

            <Field label="2. Garment *"><select className={inputCls} required disabled={!order} value={form.itemId} onChange={(event) => {
              const selectedItem = order?.items.find((entry) => String(entry.id) === event.target.value);
              setForm((current) => ({ ...current, itemId: event.target.value, variantId: "", quantity: "" }));
              setStageChoices({});
              // A garment with no variants recorded can still be allocated as a whole.
              if (selectedItem && !selectedItem.variants.length) {
                const remaining = Math.max(0, selectedItem.quantity - selectedItem.assigned.reduce((sum, batch) => sum + batch.quantity, 0));
                setForm((current) => ({ ...current, quantity: String(remaining) }));
              }
            }}><option value="">Choose garment</option>
              {order?.items.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} | {entry.quantity} ordered</option>)}
            </select></Field>

            <Field label="3. Exact garment (size and colour) *">
              {item?.variants.length ? <select className={inputCls} required value={form.variantId} onChange={(event) => {
                const chosen = item.variants.find((entry) => String(entry.id) === event.target.value);
                setForm((current) => ({ ...current, variantId: event.target.value, quantity: chosen ? String(chosen.available) : "" }));
              }}>
                <option value="">Choose size and colour</option>
                {item.variants.map((entry) => (
                  <option key={entry.id} value={entry.id} disabled={entry.available <= 0}>
                    {entry.label} | {entry.available} of {entry.quantity} left
                  </option>
                ))}
              </select>
                : <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  This garment has no variants recorded. <Link className="font-semibold underline" href={`/orders/${order?.id}`}>Add its exact sizes and colours</Link> to allocate per variant, or allocate the whole line below.
                </p>}
            </Field>

            <Field label="4. Quantity in this batch *">
              <input className={inputCls} type="number" min="1" step="1" required value={form.quantity}
                max={Math.max(1, variant ? variant.available : (item ? item.quantity - item.assigned.reduce((sum, batch) => sum + batch.quantity, 0) : 1))}
                onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
            </Field>
          </div>

          {variant && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Allocating <strong>{variant.label}</strong>: <strong>{variant.available}</strong> of {variant.quantity} still free
              ({variant.allocated} already in production).
              {order?.dueDate && <span className="ml-2">School deadline: {fmtDate(order.dueDate)}</span>}
            </p>
          )}

          {/* ---------- the route ---------- */}
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-bold text-slate-800">5. Production route</p>
              <Link href="/production/routes" className="text-xs font-semibold text-matesther-700 hover:underline">Manage routes</Link>
            </div>
            <select className={inputCls} value={form.routeChoice} onChange={(event) => { setForm({ ...form, routeChoice: event.target.value }); setStageChoices({}); }}>
              <option value="default">{item?.defaultRouteId
                ? `${routes.find((route) => route.id === item.defaultRouteId)?.name ?? "This garment's default route"}`
                : routes.some((route) => !route.productId && route.isDefault)
                  ? routes.find((route) => !route.productId && route.isDefault)?.name
                  : "Matesther standard eight-stage route"}</option>
              {routes.filter((route) => route.id !== item?.defaultRouteId).map((route) => (
                <option key={route.id} value={route.id}>{route.name}{route.productId ? ` (${route.productName ?? "garment"})` : " (all garments)"}</option>
              ))}
              <option value="custom">Build a one-off route for this batch…</option>
            </select>

            {/*
              SAY WHERE THE DEFAULT CAME FROM.

              A garment route that is silently ignored is indistinguishable from a garment
              route that was never saved, which is exactly how the product-route defect was
              first noticed: the stages shown were the organization default's and nothing on
              screen said so. This line names the route the batch will actually follow and
              why, using the same `isAutomaticRoute` rule the server resolves with - so the
              three cases read differently, and a garment with two competing unflagged routes
              says so instead of picking one at random.
            */}
            {item && (
              <p className="mt-2 text-xs text-slate-500">
                {item.defaultRouteId ? (
                  <>
                    New batches of <strong>{item.name}</strong> follow{" "}
                    <strong>{item.defaultRouteName ?? "this garment's own route"}</strong>
                    {item.defaultRouteIsGeneric ? ", the organisation-wide default, because this garment has no route of its own." : ", the route assigned to this garment."}
                  </>
                ) : (
                  <>
                    <strong>{item.name}</strong> has no route assigned, so new batches follow{" "}
                    {routes.some((route) => !route.productId && route.isDefault)
                      ? <>the organisation default, <strong>{routes.find((route) => !route.productId && route.isDefault)?.name}</strong>.</>
                      : <>Matesther's standard eight-stage route.</>}{" "}
                    <Link href="/production/routes" className="font-semibold text-matesther-700 hover:underline">Assign one</Link>
                  </>
                )}
              </p>
            )}

            {form.routeChoice === "custom" && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-slate-500">Pick the stages in the order this garment will follow them. Leave out any stage it does not need.</p>
                <div className="flex flex-wrap gap-1.5">
                  {STAGES.map((stage) => {
                    const chosen = customStages.includes(stage);
                    return <button key={stage} type="button" onClick={() => setCustomStages((current) =>
                      chosen ? current.filter((entry) => entry !== stage) : [...current, stage])}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${chosen ? "border-matesther-700 bg-matesther-700 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                      {stageLabel(stage)}
                    </button>;
                  })}
                </div>
                {customStages.length > 1 && (
                  <p className="text-xs text-slate-500">
                    Order: {customStages.map((stage, index) => `${index + 1}. ${stageLabel(stage)}`).join(" → ")}
                    <button type="button" className="ml-2 font-semibold text-matesther-700 underline"
                      onClick={() => setCustomStages((current) => [...current].sort((a, b) => STAGES.indexOf(a as typeof STAGES[number]) - STAGES.indexOf(b as typeof STAGES[number])))}>
                      sort into standard order
                    </button>
                  </p>
                )}
              </div>
            )}

            {/* What the batch will actually contain - shown before anything is created. */}
            <div className="mt-3 rounded-lg bg-slate-50 p-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                {plannedStages.length} stage{plannedStages.length === 1 ? "" : "s"} this batch will follow
              </p>
              <ol className="space-y-1">
                {plannedStages.map((stage, index) => (
                  <li key={stage.stage} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] font-bold text-slate-500">{index + 1}</span>
                    <span className="font-semibold text-slate-800">{stageLabel(stage.stage)}</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500">{methodLabel(stage.method)}</span>
                    {roleFor(stage) && <span className="text-[10px] text-slate-500">needs a {roleFor(stage)}</span>}
                    {index === 0 && <span className="text-[10px] font-semibold text-matesther-700">garments enter here</span>}
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {/* ---------- one assignment block per stage of THIS route ---------- */}
          <div className="space-y-3">
            <p className="text-sm font-bold text-slate-800">6. Who works each stage <span className="text-xs font-normal text-slate-500">(optional - any stage can be assigned later)</span></p>
            {plannedStages.map((stage, index) => {
              const role = roleFor(stage);
              const choice = choiceFor(stage.stage);
              const eligible = workers.filter((person) => person.status === "ACTIVE" && (!role || personHoldsRole(person, role)));
              const chosen = workers.find((person) => String(person.id) === choice.workerId);
              const isCutting = role === "Cutter";
              const blocked = isCutting && !canAssignCutting;
              return (
                <div key={stage.stage} className="rounded-xl border border-slate-200 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-800">
                      {index + 1}. {stageLabel(stage.stage)}
                      <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{methodLabel(stage.method)}</span>
                    </p>
                    {role && <p className="text-[11px] text-slate-500">Needs a {role}</p>}
                  </div>
                  {blocked ? (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900">
                      As a cutter-supervisor you cannot assign cutting work. Leave this stage for the Owner or a non-cutting supervisor; you may still assign every other stage.
                    </p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label={role ? `${role} *` : "Worker"}>
                        <select className={inputCls} value={choice.workerId}
                          onChange={(event) => setStageChoices({ ...stageChoices, [stage.stage]: { workerId: event.target.value, pieceRate: "", method: stage.method } })}>
                          <option value="">Assign later</option>
                          {eligible.map((person) => <option key={person.id} value={person.id}>{person.name}{person.specialty ? ` - ${person.specialty}` : ""}</option>)}
                        </select>
                        {role && !eligible.length && <p className="mt-1 text-[11px] text-amber-700">No active worker holds {role}. Add the role under Workers.</p>}
                      </Field>
                      {chosen?.paymentType === "PER_PIECE" && (
                        <Field label="Agreed pay per approved garment (₦) *">
                          <input className={inputCls} type="number" min="1" step="1" required value={choice.pieceRate}
                            onChange={(event) => setStageChoices({ ...stageChoices, [stage.stage]: { ...choice, pieceRate: event.target.value } })} />
                        </Field>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <Field label="Expected completion date"><input className={`${inputCls} max-w-xs`} type="date" value={form.expectedCompletionDate} onChange={(event) => setForm({ ...form, expectedCompletionDate: event.target.value })} /></Field>

          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error} <button type="button" className="font-semibold underline" onClick={() => void load()}>Refresh</button></div>}
          {saved && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{saved}</span>
            <Link href="/production" className="inline-flex items-center gap-1 font-bold underline">Open production <ArrowRight className="h-4 w-4" /></Link>
          </div>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="text-xs text-slate-500">
              Outsourced, machine or bought-in stages are assigned from the production board, not here - they need a vendor or a purchase rather than a worker.
            </p>
            <Btn type="submit" disabled={saving || !orders.length}><Plus className="h-4 w-4" /> {saving ? "Creating..." : "Start production"}</Btn>
          </div>
          <p className="text-[11px] text-slate-400">Methods available on a route: {PRODUCTION_METHODS.map(methodLabel).join(" · ")}.</p>
        </form>
      </Card>}
  </div>;
}
