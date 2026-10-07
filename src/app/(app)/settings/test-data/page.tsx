"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, Search, ShieldAlert } from "lucide-react";
import { Card, CardHeader, PageHeader, Loading, EmptyState, Field, inputCls, Btn } from "@/components/ui";
import { naira } from "@/lib/format";

/**
 * TEST-DATA CLEANUP — Owner only.
 *
 * This screen exists because Matesther goes into real operation with a database that
 * already contains orders created while the system was being tested, and those orders
 * cannot be removed from the Orders list. That refusal is correct and it stays: an order
 * with approved production and settled money behind it must not be deletable by a click.
 *
 * So this is a SEPARATE, LOUDER door rather than a weaker lock. It shows exactly what
 * will be removed before anything is removed, it makes the Owner type the school's name
 * and the order number back, it demands a written reason, and it refuses to proceed if
 * the order changed since the preview was taken. Every purge is recorded permanently.
 *
 * Nothing on this screen decides what is allowed. The preview, the confirmations, the
 * fingerprint and the organisation check are all enforced by POST /api/test-data-cleanup;
 * this page only refuses to offer an action the server would reject, so a button here is
 * never a button that fails.
 */

type Counts = Record<string, number>;

type Preview = {
  orderId: number;
  orderNumber: string;
  customerId: number | null;
  customerName: string | null;
  totalAmount: number;
  amountPaid: number;
  counts: Counts;
  fingerprint: string;
  payroll: {
    settledPayments: {
      paymentId: number; workerId: number; workerName: string; periodMonth: string;
      paidAmount: number; fromThisOrder: number; supportFromThisOrder: number;
    }[];
    totalSettled: number;
    affectedMonths: string[];
  };
  inventory: {
    restock: { materialId: number; materialName: string; quantity: number; unit: string }[];
    despurchase: { materialId: number; materialName: string; quantity: number; unit: string }[];
    readyMade: { materialId: number; materialName: string; quantity: number }[];
    unsafe: string[];
  };
  blockers: string[];
};

type OrderOption = { id: number; orderNumber: string; customer: string; totalAmount: number; status: string };

/** Human-readable names for the counted tables, in the order they are read. */
const TABLE_LABELS: Record<string, string> = {
  orders: "The order itself",
  order_items: "Order lines (garments)",
  order_item_sizes: "Exact variants (size and colour)",
  production_batches: "Production batches",
  production_operations: "Production stages",
  production_allocations: "Worker shares of a stage",
  production_movements: "Production ledger events",
  stage_inspections: "Stage inspections",
  quality_checks: "Quality checks",
  rework_records: "Rework records",
  external_work_orders: "Outsourced dispatches",
  support_assignments: "Support work handed out",
  support_inspections: "Support inspections",
  support_status_events: "Support lifecycle events",
  material_purchases: "Material and ready-made purchases",
  material_usage: "Material issued to the job",
  expenses: "Expenses on this order",
  payments: "Customer payments (receipts)",
  packing_records: "Packing records",
  deliveries: "Deliveries",
  delivery_lines: "Delivery garment lines",
};

/**
 * The order search is a server-side query, so it is sent once typing pauses rather than
 * on every keystroke. Same interval as the orders screen, which does the same thing.
 */
const SEARCH_DEBOUNCE_MS = 300;

export default function TestDataCleanupPage() {
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [search, setSearch] = useState("");
  const [orderId, setOrderId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [confirmNumber, setConfirmNumber] = useState("");
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ orderNumber: string; removed: Counts } | null>(null);
  const [history, setHistory] = useState<{ purges: any[]; deletions: any[] }>({ purges: [], deletions: [] });

  /** The order list is fetched paged and searched server-side, like every other list. */
  async function loadOrders(query = "") {
    setLoadingOrders(true);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (query.trim()) params.set("search", query.trim());
      const response = await fetch(`/api/orders?${params.toString()}`, { cache: "no-store" });
      const data = await response.json();
      setOrders(Array.isArray(data) ? data : []);
    } catch {
      setError("Could not load the order list.");
    } finally {
      setLoadingOrders(false);
    }
  }

  async function loadHistory() {
    try {
      const response = await fetch("/api/test-data-cleanup?history=1", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setHistory({ purges: data.purges ?? [], deletions: data.deletions ?? [] });
    } catch {
      // A failure to load the audit trail must not block a cleanup, but it is not silent
      // either: the record below simply stays as it was.
    }
  }

  /*
   * One debounced effect loads the order list, and on its first run the audit trail too.
   *
   * Two things this replaces, both worse:
   *   - it used to call `loadOrders()` immediately AND schedule a debounced one, which
   *     fetched the list twice on mount. This is a server-side query, so on a phone every
   *     extra request is both slow and wasteful.
   *   - a separate mount effect for the audit trail reads as the cleaner shape, but the
   *     `react-hooks/set-state-in-effect` rule rejects any loader invoked directly in an
   *     effect body, and this repository does not suppress that rule anywhere - it leaves
   *     all twenty-nine existing instances unfixed rather than hiding them. Adding the
   *     first suppression in the codebase for a cosmetic reason is not a trade worth making,
   *     and deferring one fetch by 300ms on a screen whose entire purpose is to be read
   *     carefully before anything is typed into it costs nothing.
   */
  const firstLoad = useRef(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      void loadOrders(search);
      if (firstLoad.current) {
        firstLoad.current = false;
        void loadHistory();
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  /** Ask the server what would be removed. Reads nothing else and removes nothing. */
  async function loadPreview(id: string) {
    setOrderId(id);
    setPreview(null);
    setError("");
    setDone(null);
    setConfirmName("");
    setConfirmNumber("");
    setReason("");
    setAccepted(false);
    if (!id) return;
    setLoadingPreview(true);
    try {
      const response = await fetch(`/api/test-data-cleanup?orderId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not prepare the cleanup preview.");
      setPreview(data as Preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare the cleanup preview.");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function execute() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/test-data-cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: preview.orderId,
          confirmCustomerName: confirmName.trim(),
          confirmOrderNumber: confirmNumber.trim(),
          reason: reason.trim(),
          // The fingerprint from THIS preview. If anything changed since it was taken the
          // server recomputes it, sees a different digest, and refuses - which is what
          // makes the confirmation single-use without storing a token.
          fingerprint: preview.fingerprint,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The cleanup did not complete.");
      setDone({ orderNumber: data.orderNumber, removed: data.removed });
      setPreview(null);
      setOrderId("");
      setAccepted(false);
      await Promise.all([loadOrders(search), loadHistory()]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The cleanup did not complete.";
      setError(message);
      // A refusal because the order moved is not a failure to retry blindly: the preview
      // is cleared so the next attempt has to look at the order as it now is.
      if (/changed since the preview/i.test(message)) setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const totalRecords = preview ? Object.values(preview.counts).reduce((sum, n) => sum + n, 0) : 0;
  const confirmationsMatch =
    !!preview &&
    confirmName.trim().toLowerCase() === String(preview.customerName ?? "").trim().toLowerCase() &&
    confirmNumber.trim() === String(preview.orderNumber).trim();
  const canExecute = confirmationsMatch && reason.trim().length >= 10 && accepted && !busy && preview?.blockers.length === 0;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/settings" className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-matesther-800">
        <ArrowLeft className="h-4 w-4" /> Back to settings
      </Link>
      <PageHeader
        title="Test-data cleanup"
        subtitle="Remove a test order and everything belonging to it, with a preview, two typed confirmations and a permanent record."
      />

      <Card className="mb-4 border-red-200 bg-red-50/70 p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-red-900">
          <ShieldAlert className="h-4 w-4 shrink-0" /> This permanently destroys records
        </p>
        <ul className="mt-2 space-y-1 text-xs leading-relaxed text-red-900/90">
          <li>• Production history, inspections, approvals, receipts, packing and deliveries on the chosen order are removed and cannot be recovered from the app.</li>
          <li>• Earnings this order generated are removed from the payroll accrual, so the payroll screen recomputes without them.</li>
          <li>
            • Money already PAID OUT to a worker is <strong>reported, never rewritten</strong>. A settled payment is a fact about a bank account, not a row to tidy —
            correct it through Worker Payments with the figures this screen gives you.
          </li>
          <li>• Shared records are never touched: the school, the garments, the workers, the routes, the materials and the business profile all survive.</li>
          <li>• Every cleanup is recorded permanently with your name, your reason and what was removed.</li>
        </ul>
      </Card>

      {done && (
        <div role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="flex items-center gap-2 font-bold"><CheckCircle2 className="h-4 w-4" /> {done.orderNumber} was removed.</p>
          <p className="mt-1 text-xs">
            {Object.entries(done.removed)
              .filter(([, count]) => count > 0)
              .map(([table, count]) => `${count} ${TABLE_LABELS[table] ?? table}`)
              .join(", ")}
            . The cleanup is recorded below and in the database.
          </p>
        </div>
      )}
      {error && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* ---- 1. choose the order ---- */}
      <Card className="mb-4 p-4">
        <CardHeader title="1. Choose the exact order" subtitle="Search by order number or school. Only your own organisation's orders are listed." />
        <div className="mt-3 grid gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search order number or school…"
              className={`${inputCls} pl-9`}
            />
          </div>
          {loadingOrders ? <Loading label="Loading orders…" /> : orders.length === 0 ? (
            <EmptyState title="No orders match" hint="Clear the search to see every order." />
          ) : (
            <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 slim-scroll">
              {orders.map((order) => (
                <button
                  key={order.id}
                  type="button"
                  onClick={() => void loadPreview(String(order.id))}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50 ${String(order.id) === orderId ? "bg-matesther-50" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-900">{order.customer}</span>
                    <span className="block text-xs text-slate-500">{order.orderNumber} · {order.status}</span>
                  </span>
                  <span className="shrink-0 text-sm font-bold text-slate-700">{naira(order.totalAmount)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* ---- 2. the preview ---- */}
      {loadingPreview && <Card className="mb-4 p-4"><Loading label="Counting what this order touches…" /></Card>}
      {preview && !loadingPreview && (
        <Card className="mb-4 p-4">
          <CardHeader
            title={`2. What will be removed from ${preview.orderNumber}`}
            subtitle={`${preview.customerName ?? "School not recorded"} · order value ${naira(preview.totalAmount)} · paid ${naira(preview.amountPaid)}`}
          />

          {preview.blockers.length > 0 && (
            <div role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              <p className="flex items-center gap-2 font-bold"><AlertTriangle className="h-4 w-4 shrink-0" /> This cleanup cannot run yet</p>
              <ul className="mt-1 space-y-1 text-xs">
                {preview.blockers.map((blocker, index) => <li key={index}>• {blocker}</li>)}
              </ul>
              <p className="mt-2 text-xs">
                Nothing has been removed. Resolve the above first — the cleanup stops rather than guess at a stock figure.
              </p>
            </div>
          )}

          <div className="mt-3 overflow-x-auto slim-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3">Record</th>
                  <th className="py-2 pr-3 text-right">Will be removed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {Object.entries(preview.counts)
                  .filter(([table]) => table !== "delivery_lines" || preview.counts.delivery_lines > 0)
                  .map(([table, count]) => (
                    <tr key={table} className={count > 0 ? "" : "text-slate-400"}>
                      <td className="py-1.5 pr-3">{TABLE_LABELS[table] ?? table}</td>
                      <td className="py-1.5 pr-3 text-right font-bold">{count}</td>
                    </tr>
                  ))}
                <tr className="border-t border-slate-200 font-bold">
                  <td className="py-2 pr-3">Total records</td>
                  <td className="py-2 pr-3 text-right">{totalRecords}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* ---- inventory: what happens to the shelf, stated explicitly ---- */}
          <div className="mt-4 rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-600">Inventory effect</p>
            {preview.inventory.restock.length === 0 && preview.inventory.despurchase.length === 0 && preview.inventory.readyMade.length === 0 ? (
              <p className="mt-1 text-xs text-slate-500">This order never touched material stock. Nothing will be adjusted.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-xs text-slate-700">
                {preview.inventory.restock.map((entry, index) => (
                  <li key={`restock-${index}`}>
                    • <strong>{entry.quantity} {entry.unit}</strong> of {entry.materialName} goes <strong>back on the shelf</strong> — it was issued to this job and never returned.
                  </li>
                ))}
                {preview.inventory.despurchase.map((entry, index) => (
                  <li key={`purchase-${index}`}>
                    • <strong>{entry.quantity} {entry.unit}</strong> of {entry.materialName} comes <strong>off the shelf</strong> — the purchase that put it there is being removed.
                  </li>
                ))}
                {preview.inventory.readyMade.map((entry, index) => (
                  <li key={`ready-${index}`}>
                    • {entry.quantity} × {entry.materialName} is a <strong>ready-made purchase</strong>: removed as a cost record only. Finished garments never enter raw-material stock, so no shelf is adjusted.
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ---- payroll: reported, never rewritten ---- */}
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-amber-800">Payroll effect</p>
            {preview.payroll.affectedMonths.length === 0 ? (
              <p className="mt-1 text-xs text-amber-900">This order generated no approved earnings. No payroll figure changes.</p>
            ) : (
              <>
                <p className="mt-1 text-xs text-amber-900">
                  Earnings from this order will disappear from the payroll accrual for{" "}
                  <strong>{preview.payroll.affectedMonths.join(", ")}</strong>, because the approved inspections behind them are removed.
                </p>
                {preview.payroll.settledPayments.length > 0 ? (
                  <>
                    <p className="mt-2 text-xs font-semibold text-amber-900">
                      These payments were ALREADY MADE and will NOT be changed:
                    </p>
                    <ul className="mt-1 space-y-1 text-xs text-amber-900">
                      {preview.payroll.settledPayments.map((payment) => (
                        <li key={payment.paymentId}>
                          • {payment.workerName}, {payment.periodMonth}: paid {naira(payment.paidAmount)}, of which{" "}
                          <strong>{naira(payment.fromThisOrder + payment.supportFromThisOrder)}</strong> came from this order.
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-amber-900">
                      Total already settled against this order: <strong>{naira(preview.payroll.totalSettled)}</strong>. Raise a correcting
                      entry under Worker Payments if it needs to come back — this screen will not rewrite a payment that reached a bank.
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-xs text-amber-900">Nothing was paid out for those months yet, so no settled payment is affected.</p>
                )}
              </>
            )}
          </div>
        </Card>
      )}

      {/* ---- 3. confirm ---- */}
      {preview && preview.blockers.length === 0 && (
        <Card className="mb-4 p-4">
          <CardHeader title="3. Confirm" subtitle="Both lines must match exactly. This confirmation is valid only for the records listed above, right now." />
          <div className="mt-3 grid gap-3">
            <Field label={`Type the school's name exactly: ${preview.customerName ?? "(none recorded)"} *`}>
              <input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} className={inputCls} autoComplete="off" placeholder={preview.customerName ?? ""} />
            </Field>
            <Field label={`Type the order number exactly: ${preview.orderNumber} *`}>
              <input value={confirmNumber} onChange={(event) => setConfirmNumber(event.target.value)} className={inputCls} autoComplete="off" placeholder={preview.orderNumber} />
            </Field>
            <Field label="Why is this order being removed? * (recorded permanently, minimum 10 characters)">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className={inputCls}
                placeholder="e.g. Test order created while trialling production before the November go-live"
              />
            </Field>
            <label className="flex items-start gap-2 text-xs text-slate-700">
              <input type="checkbox" className="mt-0.5" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
              <span>
                I have read the list above. I understand that <strong>{totalRecords} records</strong> belonging to {preview.orderNumber} will be permanently
                removed, that shared records and other orders are untouched, and that this cleanup will be recorded against my name.
              </span>
            </label>
            {!confirmationsMatch && (confirmName || confirmNumber) && (
              <p className="text-xs text-amber-700">The school name and order number must match exactly — including capitalisation of the order number.</p>
            )}
            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <Btn variant="secondary" onClick={() => { setPreview(null); setOrderId(""); setAccepted(false); }}>Cancel</Btn>
              <Btn variant="danger" disabled={!canExecute} onClick={() => void execute()}>
                {busy ? "Removing…" : `Permanently remove ${totalRecords} records`}
              </Btn>
            </div>
            {!canExecute && !busy && (
              <p className="text-right text-xs text-slate-500">
                {!confirmationsMatch ? "Type both confirmations exactly." : reason.trim().length < 10 ? "Give a reason of at least 10 characters." : !accepted ? "Tick the acknowledgement." : ""}
              </p>
            )}
          </div>
        </Card>
      )}

      {/* ---- the permanent record ---- */}
      <Card className="p-4">
        <CardHeader title="Cleanup record" subtitle="Every removal, permanently, with who ran it and why. This survives the records it describes." />
        {history.purges.length === 0 && history.deletions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Nothing has been removed yet.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {history.purges.map((purge: any) => (
              <div key={`purge-${purge.id}`} className="rounded-lg border border-red-200 bg-red-50/50 p-3 text-xs">
                <p className="font-bold text-red-900">
                  Test-data purge · {purge.orderNumber} · {purge.customerName ?? "school not recorded"}
                </p>
                <p className="mt-0.5 text-red-900/80">
                  {new Date(purge.ranAt).toLocaleString("en-GB")} by {purge.ranByName} · confirmed “{purge.confirmedCustomerName}”
                </p>
                <p className="mt-1 text-slate-700">Reason: {purge.reason}</p>
                {purge.payrollReport && <p className="mt-1 text-amber-800">Settled payroll reported at the time: {purge.payrollReport}</p>}
                {purge.inventoryReport && <p className="mt-1 text-slate-600">Inventory effect: {purge.inventoryReport}</p>}
              </div>
            ))}
            {history.deletions.map((deletion: any) => (
              <div key={`deletion-${deletion.id}`} className="rounded-lg border border-slate-200 p-3 text-xs">
                <p className="font-bold text-slate-900">
                  Order removed · {deletion.orderNumber} · {deletion.customerName ?? "school not recorded"}
                </p>
                <p className="mt-0.5 text-slate-500">
                  {new Date(deletion.deletedAt).toLocaleString("en-GB")} by {deletion.deletedByName}
                  {" · "}
                  {deletion.batchCount ?? 0} batches, {deletion.operationCount ?? 0} stages, {deletion.paymentCount ?? 0} payments, value {naira(deletion.totalAmount ?? 0)}
                </p>
                <p className="mt-1 text-slate-700">Reason: {deletion.reason}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
