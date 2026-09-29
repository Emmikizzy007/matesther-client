"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardHeader, PageHeader, Badge, Loading, EmptyState } from "@/components/ui";
import { fmtDate, stageLabel } from "@/lib/format";

export default function WorkerAssignmentsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/operations", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d))
          setRows(
            d
              .filter((o: any) => ["PENDING", "IN_PROGRESS", "SUBMITTED"].includes(o.status))
              .sort((a: any, b: any) => (a.workerName || "").localeCompare(b.workerName || ""))
          );
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader
        title="Worker Assignments"
        subtitle="Who is holding which production job right now - across all stages"
      />
      <Card>
        {loading ? <Loading /> : rows.length === 0 ? <EmptyState title="No active assignments" /> : (
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Worker</th>
                  <th className="px-3 py-3">Stage</th>
                  <th className="px-3 py-3">Order</th>
                  <th className="px-3 py-3">Customer</th>
                  <th className="px-3 py-3 text-right">Assigned</th>
                  <th className="px-3 py-3 text-right">Left</th>
                  <th className="px-3 py-3">Expected</th>
                  <th className="px-3 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-5 py-2.5 font-semibold">{o.workerName || <span className="text-amber-600">Unassigned</span>}</td>
                    <td className="px-3 py-2.5">{stageLabel(o.stage)} <span className="text-xs text-slate-400">({o.batchNumber})</span></td>
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-matesther-700">{o.orderNumber}</span>
                    </td>
                    <td className="px-3 py-2.5">{o.customer}</td>
                    <td className="px-3 py-2.5 text-right">{o.quantityReceived}</td>
                    <td className="px-3 py-2.5 text-right font-bold">{o.quantityRemaining}</td>
                    <td className="px-3 py-2.5 text-xs">{fmtDate(o.expectedCompletionDate)}</td>
                    <td className="px-3 py-2.5"><Badge status={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
