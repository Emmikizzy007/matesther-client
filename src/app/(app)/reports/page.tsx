"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardHeader, PageHeader, Badge, Loading, Btn } from "@/components/ui";
import { naira, stageLabel } from "@/lib/format";

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-[10px] font-semibold text-slate-500 shrink-0">{label}</span>
      <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 text-right text-[11px] font-bold text-slate-700 shrink-0">{naira(value)}</span>
    </div>
  );
}

export default function ReportsPage() {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr("");
    const timer = setTimeout(() => {
      if (!cancelled) {
        setErr("The report service is taking too long. The preview server may have gone to sleep - try again in a moment.");
        setLoading(false);
      }
    }, 15000);
    fetch("/api/reports", { cache: "no-store" })
      .then((x) => {
        if (!x.ok) throw new Error("Server error " + x.status);
        return x.json();
      })
      .then((d) => {
        if (!cancelled) {
          setR(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e.message || "Failed to load reports");
          setLoading(false);
        }
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  if (err)
    return (
      <Card className="p-8 text-center">
        <p className="text-sm font-semibold text-red-700">Couldn't load reports</p>
        <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">{err}</p>
        <Btn className="mt-4" onClick={() => setRetryKey((k) => k + 1)}>Try again</Btn>
      </Card>
    );
  if (!r) return <Loading label="Compiling reports…" />;

  const maxProfit = Math.max(1, ...r.profitability.map((x: any) => Math.abs(x.profit)));
  const maxStage = Math.max(1, ...r.production.map((x: any) => x.approved));
  const maxExp = Math.max(1, ...r.expensesByCategory.map((x: any) => x.amount));
  const maxRevenue = Math.max(1, ...r.profitability.map((x: any) => x.revenue));

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Is Matesther making money? Where is production stuck? Who is performing?"
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Card className="p-4"><p className="text-xs font-semibold uppercase text-slate-500">Total revenue</p><p className="text-xl font-bold">{naira(r.totals.revenue)}</p></Card>
        <Card className="p-4"><p className="text-xs font-semibold uppercase text-slate-500">Total cost</p><p className="text-xl font-bold text-red-700">{naira(r.totals.cost)}</p></Card>
        <Card className="p-4"><p className="text-xs font-semibold uppercase text-slate-500">Total profit</p><p className={`text-xl font-bold ${r.totals.profit >= 0 ? "text-matesther-700" : "text-red-700"}`}>{naira(r.totals.profit)}</p></Card>
        <Card className="p-4"><p className="text-xs font-semibold uppercase text-slate-500">Worker earnings (approved)</p><p className="text-xl font-bold text-gold-600">{naira(r.totals.workerPieceworkTotal)}</p></Card>
        <Card className="p-4"><p className="text-xs font-semibold uppercase text-slate-500">Production batches</p><p className="text-xl font-bold">{r.totals.batches}</p></Card>
      </div>

      {/* Business Growth chart */}
      <Card className="mb-4">
        <CardHeader
          title="Business Growth - Revenue vs Cost vs Profit"
          subtitle="The whole picture per order: what came in, what it cost, and what Matesther actually kept"
        />
        <div className="p-5 space-y-5">
          {r.profitability.map((p: any) => (
            <div key={p.orderId} className="border border-slate-100 rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <p className="text-sm font-bold">
                  <Link href={`/orders/${p.orderId}`} className="text-matesther-800 hover:underline">{p.orderNumber}</Link>
                  <span className="font-normal text-slate-500"> • {p.customer}</span>
                </p>
                <p className={`text-sm font-extrabold ${p.profit >= 0 ? "text-matesther-700" : "text-red-700"}`}>
                  {p.profit >= 0 ? "+" : "−"}{naira(Math.abs(p.profit))} ({p.margin}%)
                </p>
              </div>
              <div className="space-y-1.5">
                <BarRow label="Revenue" value={p.revenue} max={maxRevenue} color="bg-matesther-600" />
                <BarRow label="Cost" value={p.totalCost} max={maxRevenue} color="bg-red-500" />
                <BarRow label="Profit" value={Math.max(0, p.profit)} max={maxRevenue} color="bg-gold-500" />
              </div>
            </div>
          ))}
          {r.profitability.length === 0 && <p className="text-sm text-slate-500">No orders yet.</p>}
          <div className="flex gap-4 text-[11px] text-slate-500 border-t border-slate-100 pt-3">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-matesther-600 inline-block" /> Revenue</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-500 inline-block" /> Total cost</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-gold-500 inline-block" /> Profit</span>
          </div>
        </div>
      </Card>

      {/* Profitability */}
      <Card className="mb-4">
        <CardHeader title="Order Profitability" subtitle="Revenue − true cost (materials used + order expenses) = profit" />
        <div className="overflow-x-auto slim-scroll">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                <th className="px-5 py-3">Order</th>
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3 text-right">Revenue</th>
                <th className="px-3 py-3 text-right">Materials Used</th>
                <th className="px-3 py-3 text-right">Expenses</th>
                <th className="px-3 py-3 text-right">Total Cost</th>
                <th className="px-3 py-3 text-right">Profit</th>
                <th className="px-3 py-3 text-right">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {r.profitability.map((p: any) => (
                <tr key={p.orderId} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <Link href={`/orders/${p.orderId}`} className="font-bold text-matesther-800 hover:underline">{p.orderNumber}</Link>
                    <div className="mt-1 max-w-[120px] h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${p.profit >= 0 ? "bg-matesther-600" : "bg-red-500"}`} style={{ width: `${Math.max(2, Math.round((Math.abs(p.profit) / maxProfit) * 100))}%` }} />
                    </div>
                  </td>
                  <td className="px-3 py-3">{p.customer}</td>
                  <td className="px-3 py-3 text-right">{naira(p.revenue)}</td>
                  <td className="px-3 py-3 text-right">{naira(p.materialCost)}</td>
                  <td className="px-3 py-3 text-right">{naira(p.expenseCost)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{naira(p.totalCost)}</td>
                  <td className={`px-3 py-3 text-right font-bold ${p.profit >= 0 ? "text-matesther-700" : "text-red-700"}`}>{naira(p.profit)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{p.margin}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid xl:grid-cols-2 gap-4 mb-4">
        {/* Production */}
        <Card>
          <CardHeader title="Production Performance" subtitle="Assigned vs completed vs rejected per stage" />
          <div className="p-5 space-y-3">
            {r.production.map((p: any) => (
              <div key={p.stage}>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold">{stageLabel(p.stage)}</span>
                  <span className="text-xs text-slate-500">
                    Rcvd {p.received.toLocaleString()} • <span className="text-matesther-700 font-semibold">Approved {p.approved.toLocaleString()}</span> • <span className="text-amber-700">Rework {p.rework}</span> • <span className="text-red-600">Rej {p.rejected}</span> • Left {p.remaining.toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-gold-500 rounded-full" style={{ width: `${Math.round((p.approved / maxStage) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Expenses */}
        <Card>
          <CardHeader title="Expense Report" subtitle="Spending by category" />
          <div className="p-5 space-y-3">
            {r.expensesByCategory.map((c: any) => (
              <div key={c.category}>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold">{c.category} <span className="text-xs font-normal text-slate-400">({c.count})</span></span>
                  <span className="font-bold">{naira(c.amount)}</span>
                </div>
                <div className="mt-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-matesther-700 rounded-full" style={{ width: `${Math.round((c.amount / maxExp) * 100)}%` }} />
                </div>
              </div>
            ))}
            {r.expensesByCategory.length === 0 && <p className="text-sm text-slate-500">No expenses.</p>}
          </div>
        </Card>
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        {/* Materials */}
        <Card>
          <CardHeader title="Material Consumption" subtitle="Purchased vs used vs remaining" />
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Material</th>
                  <th className="px-3 py-3 text-right">Purchased</th>
                  <th className="px-3 py-3 text-right">Used</th>
                  <th className="px-3 py-3 text-right">In Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {r.materials.map((m: any) => (
                  <tr key={m.id} className="hover:bg-slate-50">
                    <td className="px-5 py-2.5 font-medium">{m.name} <span className="text-xs text-slate-400">({m.unit})</span></td>
                    <td className="px-3 py-2.5 text-right">{m.purchased.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right">{m.used.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right font-bold">{m.stock.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Workers */}
        <Card>
          <CardHeader title="Worker Performance" subtitle="Assigned vs completed vs rejected" />
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Worker</th>
                  <th className="px-3 py-3 text-right">Assigned</th>
                  <th className="px-3 py-3 text-right">Completed</th>
                  <th className="px-3 py-3 text-right">Rejected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {r.workers.map((w: any) => (
                  <tr key={w.id} className="hover:bg-slate-50">
                    <td className="px-5 py-2.5 font-medium">{w.name} <span className="text-xs text-slate-400 block">{w.specialty} • {w.tasks} tasks</span></td>
                    <td className="px-3 py-2.5 text-right">{w.assigned.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-matesther-700">{w.completed.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-red-600">{w.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Worker earnings */}
      <Card className="mt-4">
        <CardHeader
          title="Worker Earnings"
          subtitle="What each worker has earned on APPROVED work - pieceworkers are paid only when the inspector approves their pieces"
        />
        <div className="overflow-x-auto slim-scroll">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                <th className="px-5 py-3">Worker</th>
                <th className="px-3 py-3">Specialty</th>
                <th className="px-3 py-3">Payment Type</th>
                <th className="px-3 py-3 text-right">Pieces Approved</th>
                <th className="px-3 py-3 text-right">Rate</th>
                <th className="px-3 py-3 text-right">Earnings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {r.workerEarnings.map((w: any) => (
                <tr key={w.id} className={`hover:bg-slate-50 ${w.status !== "ACTIVE" ? "opacity-50" : ""}`}>
                  <td className="px-5 py-2.5 font-medium">{w.name}</td>
                  <td className="px-3 py-2.5">{w.specialty}</td>
                  <td className="px-3 py-2.5 text-xs">{w.paymentType.replace("_", " ")}</td>
                  <td className="px-3 py-2.5 text-right font-semibold">{w.approved.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">
                    {w.paymentType === "PER_PIECE" ? <span className="text-xs font-semibold text-slate-600">By job</span> : <>{naira(w.paymentRate)}<span className="text-[11px] text-slate-400">{w.paymentType === "MONTHLY" ? " / month" : " / day"}</span></>}
                  </td>
                  <td className="px-3 py-2.5 text-right font-bold text-matesther-700">{naira(w.earnings)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td colSpan={5} className="px-5 py-3 font-bold">
                  Total piecework earned on approved work
                  {r.totals.monthlyPayroll > 0 && (
                    <span className="block text-[11px] font-normal text-slate-500">
                      + {naira(r.totals.monthlyPayroll)} monthly wage(s) for salaried workers
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 text-right text-lg font-extrabold text-matesther-700">
                  {naira(r.totals.workerPieceworkTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}
