"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardHeader, PageHeader, Loading, EmptyState } from "@/components/ui";
import { naira } from "@/lib/format";

export default function ProfitabilityPage() {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/reports", { cache: "no-store" })
      .then((x) => x.json())
      .then(setR)
      .catch((e) => setErr(e.message));
  }, []);

  if (err) return <p className="text-sm text-red-700">Failed to load: {err}</p>;
  if (!r) return <Card><Loading label="Calculating profitability…" /></Card>;

  const maxAbs = Math.max(1, ...r.profitability.map((x: any) => Math.abs(x.profit)));

  return (
    <div>
      <PageHeader
        title="Profitability"
        subtitle="The true bottom line of every order - revenue minus the real cost of materials used and expenses"
      />

      <div className="grid md:grid-cols-3 gap-3 mb-4">
        <Card className="p-4"><p className="text-xs font-semibold uppercase text-slate-500">Total Revenue</p><p className="text-2xl font-bold">{naira(r.totals.revenue)}</p></Card>
        <Card className="p-4"><p className="text-xs font-semibold uppercase text-slate-500">Total Cost</p><p className="text-2xl font-bold text-red-700">{naira(r.totals.cost)}</p></Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase text-slate-500">Total Profit</p>
          <p className={`text-2xl font-bold ${r.totals.profit >= 0 ? "text-matesther-700" : "text-red-700"}`}>{naira(r.totals.profit)}</p>
        </Card>
      </div>

      <Card>
        <CardHeader title="Order Profitability" subtitle="Open any order to see the full cost build-up" />
        <div className="overflow-x-auto slim-scroll">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                <th className="px-5 py-3">Order</th>
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3 text-right">Quantity</th>
                <th className="px-3 py-3 text-right">Revenue</th>
                <th className="px-3 py-3 text-right">Materials Used</th>
                <th className="px-3 py-3 text-right">Expenses</th>
                <th className="px-3 py-3 text-right">Total Cost</th>
                <th className="px-3 py-3 text-right">Profit</th>
                <th className="px-3 py-3 text-right">Margin</th>
                <th className="px-3 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {r.profitability.map((p: any) => (
                <tr key={p.orderId} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <Link href={`/orders/${p.orderId}`} className="font-bold text-matesther-800 hover:underline">{p.orderNumber}</Link>
                    <div className="mt-1 max-w-[130px] h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${p.profit >= 0 ? "bg-matesther-600" : "bg-red-500"}`} style={{ width: `${Math.max(2, Math.round((Math.abs(p.profit) / maxAbs) * 100))}%` }} />
                    </div>
                  </td>
                  <td className="px-3 py-3">{p.customer}</td>
                  <td className="px-3 py-3 text-right">{p.quantity.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right">{naira(p.revenue)}</td>
                  <td className="px-3 py-3 text-right">{naira(p.materialCost)}</td>
                  <td className="px-3 py-3 text-right">{naira(p.expenseCost)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{naira(p.totalCost)}</td>
                  <td className={`px-3 py-3 text-right font-bold ${p.profit >= 0 ? "text-matesther-700" : "text-red-700"}`}>{naira(p.profit)}</td>
                  <td className="px-3 py-3 text-right font-semibold">{p.margin}%</td>
                  <td className="px-3 py-3 text-xs">{p.status.replace("_", " ")}</td>
                </tr>
              ))}
            </tbody>
            {r.profitability.length === 0 && (
              <tbody><tr><td colSpan={10}><EmptyState title="No orders yet" /></td></tr></tbody>
            )}
          </table>
        </div>
      </Card>
    </div>
  );
}
