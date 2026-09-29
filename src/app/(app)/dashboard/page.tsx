"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ShoppingBag,
  Factory,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Banknote,
  Wallet,
  Boxes,
  HandCoins,
  TrendingUp,
  Plus,
  ChevronRight,
  ClipboardCheck,
  Ruler,
  Scissors,
  Shirt,
  PenLine,
  Anchor,
  Flame,
  Package,
  Truck,
  Coins,
  RefreshCcw,
} from "lucide-react";
import { Card, CardHeader, StatCard, Badge, ProgressBar, Loading, Btn, Modal, Field, inputCls } from "@/components/ui";
import { naira, fmtDate, stageLabel } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { WorkerLinkNotice } from "@/components/WorkerLinkNotice";

const STAGE_ICONS: Record<string, any> = {
  CUTTING: Scissors,
  SEWING: Shirt,
  MONOGRAMMING: PenLine,
  BUTTONHOLE: Anchor,
  BUTTON_TACKING: Anchor,
  IRONING: Flame,
  PACKING: Package,
  DELIVERY: Truck,
};

export default function DashboardPage() {
  const { user } = useAuth();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  const [retry, setRetry] = useState(0);
  const view = user?.role === "PRODUCTION_MANAGER" ? "pm" : user?.role === "WORKER" ? "worker" : "owner";

  useEffect(() => {
    let active = true;
    setD(null);
    setErr("");
    fetch("/api/dashboard", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || "Dashboard unavailable. Please try again.");
        if (result.view !== view) throw new Error("Your session has changed. Sign out and sign in again.");
        return result;
      })
      .then((result) => { if (active) setD(result); })
      .catch((cause) => { if (active) setErr(cause instanceof Error ? cause.message : "Dashboard unavailable."); });
    return () => { active = false; };
  }, [view, retry]);

  if (err) return <Card className="p-6"><p className="text-sm font-semibold text-red-700">Could not load your dashboard</p><p className="mt-1 text-sm text-slate-600">{err}</p><Btn className="mt-4" onClick={() => setRetry((n) => n + 1)}>Try again</Btn></Card>;
  if (!d) return <Loading label="Loading Matesther dashboard..." />;

  if (view === "pm") return <ProductionDashboard d={d} />;
  if (view === "worker") return d.linked === false || !d.profile
    ? <div><h1 className="mb-5 text-2xl font-bold text-slate-900">Welcome, {user?.name}</h1><WorkerLinkNotice name={user?.name} /></div>
    : <WorkerDashboard d={d} userName={user?.name || ""} />;
  return <OwnerDashboard d={d} userName={user?.name || ""} />;
}

/* ================= OWNER DASHBOARD ================= */
function OwnerDashboard({ d }: any) {
  const k = d.kpis;
  const maxPipe = Math.max(1, ...d.pipeline.map((p: any) => p.approved));
  const [py, pm] = String(d.payroll?.month ?? "").split("-");
  const payrollLabel = py
    ? new Date(Date.UTC(Number(py), Number(pm) - 1, 1)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })
    : "This month";
  const growth = d.growth;
  const maxBar = growth
    ? Math.max(1, ...growth.months.map((m: any) => Math.max(m.revenue, m.expenses, Math.abs(m.profit))))
    : 1;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900">Welcome to Matesther</h1>
          <p className="text-sm text-slate-500 mt-1">
            Uniform Production &amp; Business Management System •{" "}
            {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
        <Link href="/orders" className="inline-flex items-center gap-1.5 bg-matesther-800 hover:bg-matesther-900 text-white px-4 py-2 rounded-lg text-sm font-medium">
          <Plus className="w-4 h-4" /> New Order
        </Link>
      </div>

      <SectionTitle
        title="Business Overview"
        right={<Link href="/payroll" className="text-xs font-semibold text-matesther-700 hover:underline">Worker Payments</Link>}
      />
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <StatCard label="Total Revenue" value={naira(k.revenue)} icon={<Banknote className="w-5 h-5" />} sub="All orders" href="/profitability" />
        <StatCard label="Total Expenses" value={naira(k.expenseTotal)} icon={<Wallet className="w-5 h-5" />} tone="red" sub="All records" href="/expenses" />
        <StatCard label="Est. Profit" value={naira(k.profit)} icon={<TrendingUp className="w-5 h-5" />} tone="green" sub={`Costs ${naira(k.totalCost)}`} href="/profitability" />
        <StatCard label="Owed by Customers" value={naira(k.outstanding)} icon={<HandCoins className="w-5 h-5" />} tone="gold" sub="Outstanding balances" href="/payments" />
        <StatCard label={`Payroll Due (${payrollLabel})`} value={naira(d.payroll?.due ?? 0)} icon={<HandCoins className="w-5 h-5" />} tone="gold" sub={`Paid ${naira(d.payroll?.paid ?? 0)} • ${naira(d.payroll?.balance ?? 0)} left`} href="/payroll" />
        <StatCard label="Material Purchases" value={naira(k.materialCost)} icon={<Boxes className="w-5 h-5" />} tone="slate" sub="Purchase records" href="/materials/purchases" />
      </div>

      {/* Business Growth - monthly revenue / expenses / profit history */}
      {growth && (
        <Card className="mb-5">
          <CardHeader
            title="Business Growth - Monthly Revenue, Expenses & Profit"
            subtitle="The history of Matesther's progress, month by month, with a year-end valuation"
            action={<Link href="/reports" className="text-xs font-medium text-matesther-700 hover:underline flex items-center gap-1">Full reports <ChevronRight className="w-3.5 h-3.5" /></Link>}
          />
          <div className="p-5">
            <div className="flex items-end gap-2 sm:gap-5 h-44">
              {growth.months.map((m: any) => (
                <div key={m.key} className="flex-1 h-full flex flex-col items-center justify-end">
                  <div className="w-full flex items-end justify-center gap-0.5 sm:gap-1 h-full">
                    <div
                      className="w-1/3 max-w-[26px] bg-matesther-600 rounded-t hover:opacity-80"
                      style={{ height: `${Math.max(1, (m.revenue / maxBar) * 100)}%` }}
                      title={`Revenue ${naira(m.revenue)}`}
                    />
                    <div
                      className="w-1/3 max-w-[26px] bg-red-400 rounded-t hover:opacity-80"
                      style={{ height: `${Math.max(1, (m.expenses / maxBar) * 100)}%` }}
                      title={`Expenses ${naira(m.expenses)}`}
                    />
                    <div
                      className="w-1/3 max-w-[26px] bg-gold-500 rounded-t hover:opacity-80"
                      style={{ height: `${Math.max(1, (Math.max(0, m.profit) / maxBar) * 100)}%` }}
                      title={`Profit ${naira(m.profit)}`}
                    />
                  </div>
                  <p className="text-[10px] font-bold text-slate-500 mt-1.5">{m.label}</p>
                  <p className={`text-[10px] font-semibold ${m.profit >= 0 ? "text-matesther-700" : "text-red-600"}`}>{naira(m.profit)}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 text-[11px] text-slate-500 mt-4">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-matesther-600 inline-block" /> Revenue (orders received)</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-400 inline-block" /> Expenses (spent + materials used)</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-gold-500 inline-block" /> Profit</span>
              <span className="text-slate-400">Hover a bar for the exact figure</span>
            </div>

            {/* Year valuations */}
            <div className="grid sm:grid-cols-2 gap-3 mt-4">
              {growth.years.map((y: any) => (
                <div key={y.year} className={`rounded-lg border p-4 ${y.ytd ? "border-gold-400 bg-gold-400/10" : "border-slate-200"}`}>
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-600">
                    {y.year} {y.ytd && <span className="text-gold-600">• Year-to-date valuation</span>}
                  </p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-sm">
                    <span className="text-slate-500">Revenue</span><span className="text-right font-semibold">{naira(y.revenue)}</span>
                    <span className="text-slate-500">Expenses</span><span className="text-right font-semibold text-red-700">{naira(y.expenses)}</span>
                    <span className="text-slate-500">Profit</span><span className={`text-right font-extrabold ${y.profit >= 0 ? "text-matesther-700" : "text-red-700"}`}>{naira(y.profit)}</span>
                    <span className="text-slate-500">Profit margin</span><span className="text-right font-bold">{y.margin}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      <SectionTitle title="Orders" />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <StatCard label="Active Orders" value={String(k.activeOrders)} icon={<ShoppingBag className="w-5 h-5" />} href="/orders" />
        <StatCard label="In Production" value={String(k.inProduction)} icon={<Factory className="w-5 h-5" />} tone="blue" href="/production" />
        <StatCard label="Due Soon (14d)" value={String(k.dueSoon)} icon={<Clock className="w-5 h-5" />} tone="gold" sub={k.dueToday > 0 ? `${k.dueToday} due today` : "-"} href="/orders" />
        <StatCard label="Completed" value={String(k.completedOrders)} icon={<CheckCircle2 className="w-5 h-5" />} href="/orders" />
        <StatCard label="Delayed" value={String(k.delayed)} icon={<AlertTriangle className="w-5 h-5" />} tone="red" sub={k.delayed > 0 ? "Needs attention" : "All on track"} href="/orders" />
      </div>

      <SectionTitle
        title="Production"
        right={
          <div className="flex gap-3 text-xs">
            <Link href="/production/inspection" className="font-semibold text-violet-700 hover:underline">
              {k.inspectionQueue} awaiting inspection
            </Link>
            {k.reworkPending > 0 && (
              <span className="font-semibold text-amber-700">{k.reworkPending} in rework</span>
            )}
          </div>
        }
      />
      <Card className="mb-5">
        <div className="p-5 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
          {d.pipeline.map((p: any, i: number) => {
            const Icon = STAGE_ICONS[p.stage] ?? Scissors;
            return (
              <Link key={p.stage} href={`/production?stage=${p.stage}`} className={`block rounded-lg border p-3 transition-all hover:shadow-md hover:border-matesther-600 ${p.awaitingInspection > 0 ? "border-violet-300 bg-violet-50/40" : "border-slate-200"}`}>
                <div className="flex items-center gap-1.5">
                  <Icon className="w-4 h-4 text-matesther-800" />
                  <p className="text-[10px] font-bold uppercase tracking-wide text-matesther-800">{i + 1}. {stageLabel(p.stage)}</p>
                </div>
                <p className="text-lg font-bold mt-1">{p.approved.toLocaleString()}</p>
                <p className="text-[11px] text-slate-500">approved</p>
                <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-gold-500 rounded-full" style={{ width: `${Math.round((p.approved / maxPipe) * 100)}%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-2 text-[10px]">
                  {p.awaitingInspection > 0 && <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 font-semibold">{p.awaitingInspection} to inspect</span>}
                  {p.rework > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">{p.rework} rework</span>}
                </div>
              </Link>
            );
          })}
        </div>
        <div className="px-5 pb-4 flex gap-4 text-xs text-slate-500">
          <Link href="/production" className="text-matesther-700 font-semibold hover:underline flex items-center gap-1">Active Production <ChevronRight className="w-3.5 h-3.5" /></Link>
          <Link href="/production/inspection" className="text-violet-700 font-semibold hover:underline flex items-center gap-1">Inspection Queue <ChevronRight className="w-3.5 h-3.5" /></Link>
          <Link href="/production/history" className="text-matesther-700 font-semibold hover:underline flex items-center gap-1">Production History <ChevronRight className="w-3.5 h-3.5" /></Link>
        </div>
      </Card>

      <SectionTitle title="Materials" right={<Link href="/materials" className="text-xs font-semibold text-matesther-700 hover:underline">Manage</Link>} />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        <StatCard label="Stock Value" value={naira(k.stockValue)} icon={<Ruler className="w-5 h-5" />} tone="slate" sub="Materials on hand" href="/materials" />
        <StatCard label="Low Stock Items" value={String(d.lowStock.length)} icon={<AlertTriangle className="w-5 h-5" />} tone={d.lowStock.length ? "red" : "green"} sub={d.lowStock.length ? d.lowStock[0].name : "All healthy"} href="/materials" />
        <StatCard label="Material Costs (bought)" value={naira(k.materialCost)} icon={<Boxes className="w-5 h-5" />} tone="blue" href="/materials/purchases" />
      </div>

      <SectionTitle title="Recent Activity" />
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card>
          <CardHeader title="Recent Orders" action={<Link href="/orders" className="text-xs font-medium text-matesther-700 hover:underline">View all</Link>} />
          <div className="divide-y divide-slate-100">
            {d.recentOrders.map((o: any) => (
              <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{o.orderNumber} <span className="font-normal text-slate-500">• {o.customer}</span></p>
                  <div className="flex items-center gap-2 mt-1">
                    <ProgressBar pct={o.progress} className="max-w-[120px]" />
                    <span className="text-[11px] text-slate-500">{o.progress}%</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold">{naira(o.totalAmount)}</p>
                  <div className="mt-0.5"><Badge status={o.status} /></div>
                </div>
              </Link>
            ))}
            {d.recentOrders.length === 0 && <p className="p-5 text-sm text-slate-500">No orders yet.</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Inspections" subtitle="Quality gate activity" action={<Link href="/production/inspection" className="text-xs font-medium text-violet-700 hover:underline">Queue</Link>} />
          <div className="divide-y divide-slate-100">
            {d.recentInspections.map((i: any) => (
              <div key={i.id} className="px-5 py-3">
                <p className="text-sm font-semibold">{stageLabel(i.stage)} - {i.batchNumber} <span className="font-normal text-slate-500">• {i.orderNumber}</span></p>
                <p className="text-xs text-slate-500">
                  <span className="text-emerald-700 font-semibold">{i.quantityApproved} approved</span>
                  {i.quantityRework > 0 && <span className="text-amber-700"> • {i.quantityRework} rework</span>}
                  {i.quantityRejected > 0 && <span className="text-red-600"> • {i.quantityRejected} rejected</span>}
                  {" "}by {i.inspectedBy} • {fmtDate(i.inspectedAt)}
                </p>
              </div>
            ))}
            {d.recentInspections.length === 0 && <p className="p-5 text-sm text-slate-500">No inspections yet.</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent Expenses" action={<Link href="/expenses" className="text-xs font-medium text-matesther-700 hover:underline">All</Link>} />
          <div className="divide-y divide-slate-100">
            {d.recentExpenses.map((e: any) => (
              <div key={e.id} className="px-5 py-3">
                <p className="text-sm font-semibold truncate">{e.description}</p>
                <p className="text-xs text-slate-500">{e.category}{e.orderNumber ? ` • ${e.orderNumber}` : " • General"} • {fmtDate(e.date)}</p>
                <p className="text-sm font-bold mt-0.5">{naira(e.amount)}</p>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent Payments" action={<Link href="/payments" className="text-xs font-medium text-matesther-700 hover:underline">All</Link>} />
          <div className="divide-y divide-slate-100">
            {d.recentPayments.map((p: any) => (
              <div key={p.id} className="px-5 py-3">
                <p className="text-sm font-semibold truncate">{p.customer}</p>
                <p className="text-xs text-slate-500">{p.orderNumber} • {p.method} • {fmtDate(p.date)}</p>
                <p className="text-sm font-bold text-matesther-700 mt-0.5">{naira(p.amount)}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ================= PROJECT MANAGER DASHBOARD (production only - no money) ================= */
function ProductionDashboard({ d }: any) {
  const maxPipe = Math.max(1, ...d.pipeline.map((p: any) => p.approved));
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900">Production Dashboard</h1>
          <p className="text-sm text-slate-500 mt-1">
            Matesther production floor - supervise stages, inspect submissions, keep the pipeline moving.
          </p>
        </div>
        <Link href="/production/inspection" className="inline-flex items-center gap-1.5 bg-violet-700 hover:bg-violet-800 text-white px-4 py-2 rounded-lg text-sm font-medium">
          <ClipboardCheck className="w-4 h-4" /> Open Inspection Queue
        </Link>
      </div>

      <SectionTitle title="Today" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard label="Jobs Due Today" value={String(d.today.dueTodayJobs.length)} icon={<Clock className="w-5 h-5" />} tone="gold" href="/production" />
        <StatCard label="Awaiting Inspection" value={String(d.today.awaitingInspection.length)} icon={<ClipboardCheck className="w-5 h-5" />} tone="blue" sub={`${d.inspection.awaiting.reduce((s: number, x: any) => s + x.pendingInspection, 0)} pieces`} href="/production/inspection" />
        <StatCard label="Rework In Progress" value={String(d.today.rework.length)} icon={<RefreshCcw className="w-5 h-5" />} tone="red" href="/production/inspection" />
        <StatCard label="Stages Running" value={String(d.pipeline.filter((p: any) => p.active > 0).length)} icon={<Factory className="w-5 h-5" />} href="/production" />
      </div>

      <SectionTitle title="Production Pipeline" right={<span className="text-xs text-slate-500">Cutting → Sewing → Monogramming / Embroidery → Buttonhole → Button Tacking → Ironing → Packing → Delivery</span>} />
      <Card className="mb-5">
        <div className="p-5 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
          {d.pipeline.map((p: any, i: number) => {
            const Icon = STAGE_ICONS[p.stage] ?? Scissors;
            return (
              <Link key={p.stage} href={`/production?stage=${p.stage}`} className={`block rounded-lg border p-3 transition-all hover:shadow-md hover:border-matesther-600 ${p.awaitingInspection > 0 ? "border-violet-300 bg-violet-50/40" : "border-slate-200"}`}>
                <div className="flex items-center gap-1.5">
                  <Icon className="w-4 h-4 text-matesther-800" />
                  <p className="text-[10px] font-bold uppercase tracking-wide text-matesther-800">{i + 1}. {stageLabel(p.stage)}</p>
                </div>
                <p className="text-lg font-bold mt-1">{p.approved.toLocaleString()}</p>
                <p className="text-[11px] text-slate-500">approved</p>
                <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-gold-500 rounded-full" style={{ width: `${Math.round((p.approved / maxPipe) * 100)}%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-2 text-[10px]">
                  {p.awaitingInspection > 0 && <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 font-semibold">{p.awaitingInspection} to inspect</span>}
                  {p.rework > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">{p.rework} rework</span>}
                </div>
              </Link>
            );
          })}
        </div>
      </Card>

      <SectionTitle title="Worker Activity" right={<Link href="/workers" className="text-xs font-semibold text-matesther-700 hover:underline">Workers</Link>} />
      <Card className="mb-5">
        <div className="overflow-x-auto slim-scroll">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                <th className="px-5 py-3">Worker</th>
                <th className="px-3 py-3">Specialty</th>
                <th className="px-3 py-3 text-right">Active Jobs</th>
                <th className="px-3 py-3 text-right">Assigned</th>
                <th className="px-3 py-3 text-right">Submitted</th>
                <th className="px-3 py-3 text-right">Approved</th>
                <th className="px-3 py-3 text-right">Overdue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {d.workerActivity.map((w: any) => (
                <tr key={w.name} className="hover:bg-slate-50">
                  <td className="px-5 py-2.5 font-semibold">{w.name}</td>
                  <td className="px-3 py-2.5">{w.specialty}</td>
                  <td className="px-3 py-2.5 text-right font-bold">{w.activeJobs}</td>
                  <td className="px-3 py-2.5 text-right">{w.assigned.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">{w.submitted.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right text-matesther-700 font-semibold">{w.approved.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">{w.overdue > 0 ? <span className="text-red-700 font-bold">{w.overdue}</span> : "0"}</td>
                </tr>
              ))}
              {d.workerActivity.length === 0 && <tr><td colSpan={7} className="p-5 text-sm text-slate-500">No worker activity.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <SectionTitle title="Inspection" right={<Link href="/production/inspection" className="text-xs font-semibold text-violet-700 hover:underline">Inspection Queue</Link>} />
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Awaiting Inspection" subtitle="Submitted by workers - inspect to approve, rework or reject" />
          <div className="divide-y divide-slate-100">
            {d.inspection.awaiting.map((o: any) => (
              <Link key={o.id} href={`/production/inspection?op=${o.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-violet-50/40">
                <div>
                  <p className="text-sm font-semibold">{stageLabel(o.stage)} - {o.batchNumber} <span className="font-normal text-slate-500">• {o.orderNumber} • {o.customer}</span></p>
                  <p className="text-xs text-slate-500 mt-0.5">Worker: {o.workerName || "Unassigned"} • {fmtDate(o.expectedCompletionDate)}</p>
                </div>
                <span className="text-xs font-bold text-violet-700 bg-violet-100 rounded-full px-2.5 py-1 shrink-0">{o.pendingInspection} pcs</span>
              </Link>
            ))}
            {d.inspection.awaiting.length === 0 && <p className="p-5 text-sm text-slate-500">Nothing awaiting inspection. ✓</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recently Inspected" />
          <div className="divide-y divide-slate-100">
            {d.inspection.recentApproved.map((i: any) => (
              <div key={i.id} className="px-5 py-3">
                <p className="text-sm font-semibold">{stageLabel(i.stage)} - {i.orderNumber} <span className="font-normal text-slate-500">• {i.batchNumber}</span></p>
                <p className="text-xs text-slate-500">
                  <span className="text-emerald-700 font-semibold">{i.quantityApproved} approved</span>
                  {i.quantityRework > 0 && <span className="text-amber-700"> • {i.quantityRework} rework</span>}
                  {i.quantityRejected > 0 && <span className="text-red-600"> • {i.quantityRejected} rejected</span>}
                  {" "}by {i.inspectedBy} • {fmtDate(i.inspectedAt)}
                </p>
              </div>
            ))}
            {d.inspection.recentApproved.length === 0 && <p className="p-5 text-sm text-slate-500">No inspections recorded yet.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ================= WORKER DASHBOARD (personal work journal) ================= */
function WorkerDashboard({ d, userName }: any) {
  const [submit, setSubmit] = useState<any>(null);
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function doSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/operations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: submit.id, submitQty: Number(qty) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setSubmit(null);
      window.location.reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const p = d.profile;
  const rateNote = p?.paymentType === "PER_PIECE" ? "pay agreed for each production job" : `${naira(p.paymentRate)} / month`;

  return (
    <div>
      <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mb-1">Hello, {p?.name || userName}</h1>
      <p className="text-sm text-slate-500 mb-5">
        {p?.specialty} • {rateNote} - your work journal for today.
      </p>

      <SectionTitle title="Today's Jobs" right={<Link href="/worker/jobs" className="text-xs font-semibold text-matesther-700 hover:underline">My Jobs</Link>} />
      <div className="grid md:grid-cols-2 gap-3 mb-5">
        {d.todayJobs.map((j: any) => (
          <Card key={j.id} className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-matesther-800">{stageLabel(j.stage)}</p>
              <Badge status={j.status} />
            </div>
            <p className="text-sm mt-1">{j.customer} <span className="text-slate-500">• {j.orderNumber}</span></p>
            <p className="mt-0.5 text-xs font-semibold text-slate-700">{j.garment}{j.size ? ` • Size ${j.size}` : ""}{j.color ? ` • ${j.color}` : ""}</p>
            <p className="text-xs text-slate-500 mt-0.5">Batch {j.batchNumber} • due {fmtDate(j.expectedCompletionDate)}</p>
            {p?.paymentType === "PER_PIECE" && <p className="mt-1 text-xs font-bold text-matesther-700">Your agreed pay: {naira(j.pieceRate ?? p.paymentRate)} per approved piece</p>}
            <div className="flex items-center gap-2 mt-3 text-[11px]">
              <span className="bg-slate-100 rounded px-1.5 py-0.5">Left {j.quantityRemaining}</span>
              <span className="bg-matesther-50 text-matesther-800 rounded px-1.5 py-0.5 font-semibold">Done {j.quantityCompleted}</span>
              {j.pendingInspection > 0 && <span className="bg-violet-100 text-violet-800 rounded px-1.5 py-0.5 font-semibold">{j.pendingInspection} with inspector</span>}
            </div>
            {["IN_PROGRESS", "SUBMITTED"].includes(j.status) && j.availableToSubmit > 0 && (
              <Btn variant="secondary" className="mt-3 w-full" onClick={() => { setErr(""); setQty(String(j.availableToSubmit)); setSubmit(j); }}>
                Mark finished - submit for inspection
              </Btn>
            )}
          </Card>
        ))}
        {d.todayJobs.length === 0 && <Card className="p-5 text-sm text-slate-500 md:col-span-2">No active jobs today. Enjoy the break! 🧵</Card>}
      </div>

      <SectionTitle title="My Earnings" right={<Link href="/worker/earnings" className="text-xs font-semibold text-matesther-700 hover:underline">Full breakdown</Link>} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <StatCard label="Today" value={naira(d.earnings.today)} icon={<Coins className="w-5 h-5" />} href="/worker/earnings" />
          <StatCard label="This Week" value={naira(d.earnings.week)} icon={<Coins className="w-5 h-5" />} tone="blue" href="/worker/earnings" />
          <StatCard label="This Month" value={naira(d.earnings.month)} icon={<Coins className="w-5 h-5" />} tone="gold" href="/worker/earnings" />
          <StatCard label="Total Earnings" value={naira(d.earnings.total)} icon={<Banknote className="w-5 h-5" />} tone="green" sub="On approved pieces" href="/worker/earnings" />
      </div>

      <SectionTitle title="Recent Jobs" />
      <Card>
        <div className="divide-y divide-slate-100">
          {d.recentJobs.map((j: any) => (
            <div key={j.id} className="flex items-center justify-between px-5 py-3 text-sm">
              <div>
                <p className="font-semibold">{stageLabel(j.stage)} - {j.batchNumber} <span className="font-normal text-slate-500">• {j.orderNumber} • {j.customer}</span></p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {j.quantityApproved} pieces approved
                  {j.quantityRework > 0 && ` • ${j.quantityRework} sent for rework`}
                  {" "}{j.completedAt ? `• ${fmtDate(j.completedAt)}` : ""}
                </p>
              </div>
              <Badge status="COMPLETED" />
            </div>
          ))}
          {d.recentJobs.length === 0 && <p className="p-5 text-sm text-slate-500">No completed jobs yet.</p>}
        </div>
      </Card>

      <Modal open={!!submit} onClose={() => setSubmit(null)} title="Submit work for inspection">
        <form onSubmit={doSubmit} className="space-y-3">
          <p className="text-sm text-slate-600">
            <span className="font-semibold">{stageLabel(submit?.stage)}</span> - {submit?.batchNumber} ({submit?.orderNumber}).
            How many finished pieces are ready for the inspector to check?
          </p>
          <Field label="Pieces ready *">
            <input type="number" min="1" max={submit?.availableToSubmit ?? 1} required value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
          </Field>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <p className="text-xs text-slate-500">Once submitted, the Project Manager or Owner inspects the pieces and records approved / rework / rejected.</p>
          <div className="flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setSubmit(null)}>Cancel</Btn>
            <Btn type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit for inspection"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ---------- shared ---------- */
function SectionTitle({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      {right}
    </div>
  );
}
