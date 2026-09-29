"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardHeader, PageHeader, Badge, Loading, EmptyState } from "@/components/ui";
import { fmtDateTime, fmtDate, stageLabel } from "@/lib/format";
import { useAuth } from "@/lib/auth";

export default function ProductionHistoryPage() {
  const { user } = useAuth();
  const [inspections, setInspections] = useState<any[]>([]);
  const [ops, setOps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/inspections", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/operations", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([i, o]) => {
        setInspections(Array.isArray(i) ? i : []);
        setOps(Array.isArray(o) ? o : []);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Card><Loading label="Compiling production history…" /></Card>;

  const sortedOps = [...ops].sort(
    (a, b) => a.batchNumber.localeCompare(b.batchNumber) || a.id - b.id
  );

  return (
    <div>
      <PageHeader
        title="Production History"
        subtitle="The complete audit trail - every assignment, submission, inspection and result. Nothing is ever overwritten."
      />

      <Card className="mb-4">
        <CardHeader title="Inspection Records" subtitle="Who inspected what, when, and what happened to each piece" />
        <div className="overflow-x-auto slim-scroll">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                <th className="px-5 py-3">Date</th>
                <th className="px-3 py-3">Stage</th>
                <th className="px-3 py-3">Order / Batch</th>
                <th className="px-3 py-3">Worker</th>
                <th className="px-3 py-3">Inspector</th>
                <th className="px-3 py-3 text-right">Approved</th>
                <th className="px-3 py-3 text-right">Rework</th>
                <th className="px-3 py-3 text-right">Rejected</th>
                <th className="px-3 py-3">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {inspections.map((i) => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <td className="px-5 py-2.5 whitespace-nowrap text-xs">{fmtDateTime(i.inspectedAt)}</td>
                  <td className="px-3 py-2.5 font-semibold">{stageLabel(i.stage)}</td>
                  <td className="px-3 py-2.5">
                    {user?.role === "OWNER"
                      ? <Link href={`/orders/${i.orderId}`} className="text-matesther-700 hover:underline font-medium">{i.orderNumber}</Link>
                      : <span className="font-medium text-matesther-700">{i.orderNumber}</span>}
                    <span className="text-xs text-slate-500"> • {i.batchNumber}</span>
                  </td>
                  <td className="px-3 py-2.5">{i.workerName || "-"}</td>
                  <td className="px-3 py-2.5">{i.inspectedBy}</td>
                  <td className="px-3 py-2.5 text-right font-bold text-emerald-700">{i.quantityApproved}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-amber-700">{i.quantityRework || "-"}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-red-600">{i.quantityRejected || "-"}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-500 max-w-[220px] truncate">{i.notes || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {inspections.length === 0 && <EmptyState title="No inspection records yet" />}
        </div>
      </Card>

      <Card>
        <CardHeader title="Stage Ledger" subtitle="Current state of every stage across all batches" />
        <div className="overflow-x-auto slim-scroll">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                <th className="px-5 py-3">Batch</th>
                <th className="px-3 py-3">Order</th>
                <th className="px-3 py-3">Stage</th>
                <th className="px-3 py-3">Worker</th>
                <th className="px-3 py-3 text-right">Assigned</th>
                <th className="px-3 py-3 text-right">Submitted</th>
                <th className="px-3 py-3 text-right">Approved</th>
                <th className="px-3 py-3 text-right">Rework</th>
                <th className="px-3 py-3 text-right">Rejected</th>
                <th className="px-3 py-3 text-right">Left</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Expected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {sortedOps.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50">
                  <td className="px-5 py-2.5 font-semibold">{o.batchNumber}</td>
                  <td className="px-3 py-2.5">
                    {user?.role === "OWNER"
                      ? <Link href={`/orders/${o.orderId}`} className="text-matesther-700 hover:underline">{o.orderNumber}</Link>
                      : <span className="text-matesther-700">{o.orderNumber}</span>}
                  </td>
                  <td className="px-3 py-2.5">{stageLabel(o.stage)}</td>
                  <td className="px-3 py-2.5 text-xs">{o.workerName || "-"}</td>
                  <td className="px-3 py-2.5 text-right">{o.quantityReceived}</td>
                  <td className="px-3 py-2.5 text-right">{o.quantityCompleted}</td>
                  <td className="px-3 py-2.5 text-right text-emerald-700 font-semibold">{o.quantityApproved}</td>
                  <td className="px-3 py-2.5 text-right text-amber-700">{o.quantityRework || "-"}</td>
                  <td className="px-3 py-2.5 text-right text-red-600">{o.quantityRejected || "-"}</td>
                  <td className="px-3 py-2.5 text-right font-bold">{o.quantityRemaining}</td>
                  <td className="px-3 py-2.5"><Badge status={o.status} /></td>
                  <td className="px-3 py-2.5 text-xs">{fmtDate(o.expectedCompletionDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
