"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardHeader, PageHeader, StatCard, Badge, Loading, Modal, Field, inputCls, Btn } from "@/components/ui";
import { naira, fmtDate, fmtDateTime, stageLabel } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { WorkerLinkNotice } from "@/components/WorkerLinkNotice";
import { Coins, Banknote, Briefcase, Clock } from "lucide-react";

type Mode = "jobs" | "journal" | "earnings" | "profile";

export default function WorkerPages({ mode }: { mode: Mode }) {
  const { user } = useAuth();
  const [d, setD] = useState<any>(null);
  const [inspections, setInspections] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [retry, setRetry] = useState(0);
  const [submit, setSubmit] = useState<any>(null);
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState("");

  useEffect(() => {
    if (!user || user.role !== "WORKER") return;
    let active = true;
    setD(null);
    setErr("");
    fetch("/api/dashboard", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || "Your work is temporarily unavailable.");
        if (result.view !== "worker") throw new Error("Your session changed. Please sign in again.");
        return result;
      })
      .then((data) => {
        if (!active) return;
        setD(data);
        const ids = (data.journal ?? []).map((job: any) => job.id);
        if (!ids.length) { setInspections([]); return; }
        fetch("/api/inspections?limit=200", { cache: "no-store" })
          .then((response) => response.ok ? response.json() : [])
          .then((rows: any) => {
            if (active) setInspections(Array.isArray(rows) ? rows.filter((check: any) => ids.includes(check.productionOperationId)) : []);
          })
          .catch(() => { if (active) setInspections([]); });
      })
      .catch((cause) => { if (active) setErr(cause instanceof Error ? cause.message : "Your work is temporarily unavailable."); });
    return () => { active = false; };
  }, [user?.email, user?.role, retry]);

  async function doSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSubmitErr("");
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
      setSubmitErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (err) return <Card className="p-6"><p className="text-sm font-semibold text-red-700">Could not load your work</p><p className="mt-1 text-sm text-slate-600">{err}</p><Btn className="mt-4" onClick={() => setRetry((n) => n + 1)}>Try again</Btn></Card>;
  if (!d) return <Card><Loading label="Loading your work..." /></Card>;
  if (d.linked === false || !d.profile) return (
    <div>
      <PageHeader title={{ jobs: "My Jobs", journal: "My Journal", earnings: "My Earnings", profile: "Profile" }[mode]} />
      <WorkerLinkNotice name={user?.name} manager={user?.role === "PRODUCTION_MANAGER"} />
    </div>
  );

  const p = d.profile;
  const rate = p?.paymentType === "PER_PIECE" ? "Agreed separately for each production job" : `${naira(p.paymentRate)} per month`;

  if (mode === "profile") {
    return (
      <div>
        <PageHeader title="Profile" subtitle="Your Matesther production profile" />
        <Card className="max-w-lg p-5 space-y-3 text-sm">
          <div><p className="text-xs font-semibold uppercase text-slate-400">Name</p><p className="font-bold text-lg">{p.name}</p></div>
          <div><p className="text-xs font-semibold uppercase text-slate-400">Specialty</p><p className="font-semibold">{p.specialty}</p></div>
          <div><p className="text-xs font-semibold uppercase text-slate-400">Phone</p><p>{p.phone || "-"}</p></div>
          <div><p className="text-xs font-semibold uppercase text-slate-400">Payment</p><p className="font-semibold">{p.paymentType.replace("_", " ")} - {rate}</p></div>
          <div><p className="text-xs font-semibold uppercase text-slate-400">Signed in as</p><p>{user?.name} ({user?.email})</p></div>
        </Card>
      </div>
    );
  }

  if (mode === "earnings") {
    return (
      <div>
        <PageHeader title="My Earnings" subtitle={p?.paymentType === "PER_PIECE" ? "You are paid when your work is inspected and approved" : "Monthly wage worker"} />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <StatCard label="Today" value={naira(d.earnings.today)} icon={<Coins className="w-5 h-5" />} />
          <StatCard label="This Week" value={naira(d.earnings.week)} icon={<Coins className="w-5 h-5" />} tone="blue" />
          <StatCard label="This Month" value={naira(d.earnings.month)} icon={<Coins className="w-5 h-5" />} tone="gold" />
          <StatCard label="Total" value={naira(d.earnings.total)} icon={<Banknote className="w-5 h-5" />} tone="green" />
        </div>
        <Card>
          <CardHeader title="Approved work and earnings" subtitle="Each inspection uses the agreed rate on that production job" />
          <div className="overflow-x-auto slim-scroll">
            <table className="w-full text-sm min-w-[680px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-3 py-3">Job</th>
                  <th className="px-3 py-3">Order</th>
                  <th className="px-3 py-3 text-right">Pieces Approved</th>
                  <th className="px-3 py-3 text-right">Rate</th>
                  <th className="px-3 py-3 text-right">Earned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {d.earnings.events.map((e: any) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="px-5 py-2.5 text-xs">{fmtDateTime(e.inspectedAt)}</td>
                    <td className="px-3 py-2.5 font-semibold">{stageLabel(e.stage)} <span className="text-xs font-normal text-slate-400">({e.batchNumber})</span></td>
                    <td className="px-3 py-2.5">{e.orderNumber} <span className="text-xs text-slate-500">• {e.customer}</span></td>
                    <td className="px-3 py-2.5 text-right">{e.quantityApproved}</td>
                    <td className="px-3 py-2.5 text-right">{naira(e.pieceRate)}</td>
                    <td className="px-3 py-2.5 text-right font-bold text-matesther-700">{naira(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.earnings.events.length === 0 && <p className="p-5 text-sm text-slate-500">No approved pieces yet - your earnings appear once the inspector approves your work.</p>}
          </div>
        </Card>
      </div>
    );
  }

  if (mode === "journal") {
    return (
      <div>
        <PageHeader title="My Journal" subtitle="Your full work history - every job, submission and inspection result" />
        <div className="space-y-3">
          {d.journal.map((j: any) => {
            const my = inspections.filter((i) => i.productionOperationId === j.id);
            return (
              <Card key={j.id}>
                <div className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold">{stageLabel(j.stage)} - {j.batchNumber}</p>
                      <p className="text-xs text-slate-500">
                        <Link href="/worker/jobs" className="text-matesther-700 hover:underline">{j.orderNumber}</Link> • {j.customer} • {j.garment}{j.size ? ` • Size ${j.size}` : ""}{j.color ? ` • ${j.color}` : ""}
                      </p>
                    </div>
                    <Badge status={j.status} />
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3 text-[11px]">
                    <span className="bg-slate-100 rounded px-2 py-1">Assigned {j.quantityReceived}</span>
                    <span className="bg-violet-50 text-violet-800 rounded px-2 py-1 font-semibold">Submitted {j.quantityCompleted}</span>
                    <span className="bg-emerald-50 text-emerald-800 rounded px-2 py-1 font-semibold">Approved {j.quantityApproved}</span>
                    {j.quantityRework > 0 && <span className="bg-amber-100 text-amber-800 rounded px-2 py-1 font-semibold">Rework {j.quantityRework}</span>}
                    {j.quantityRejected > 0 && <span className="bg-red-50 text-red-700 rounded px-2 py-1 font-semibold">Rejected {j.quantityRejected}</span>}
                    <span className="bg-slate-100 rounded px-2 py-1">Left {j.quantityRemaining}</span>
                  </div>
                  {my.length > 0 && (
                    <div className="mt-3 border-l-2 border-matesther-100 pl-3 space-y-1">
                      {my.map((i) => (
                        <p key={i.id} className="text-[11px] text-slate-500">
                          <span className="font-semibold text-slate-600">{fmtDateTime(i.inspectedAt)} - {i.inspectedBy}:</span>{" "}
                          <span className="text-emerald-700">{i.quantityApproved} approved</span>
                          {i.quantityRework > 0 && <span className="text-amber-700"> • {i.quantityRework} rework</span>}
                          {i.quantityRejected > 0 && <span className="text-red-600"> • {i.quantityRejected} rejected</span>}
                          {i.notes ? ` - “${i.notes}”` : ""}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
          {d.journal.length === 0 && <Card><p className="p-5 text-sm text-slate-500">No jobs assigned to you yet.</p></Card>}
        </div>
      </div>
    );
  }

  // mode === "jobs"
  return (
    <div>
      <PageHeader title="My Jobs" subtitle="Active production jobs assigned to you - submit finished pieces for inspection" />
      <Card>
        <div className="overflow-x-auto slim-scroll">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-100">
                <th className="px-5 py-3">School</th>
                <th className="px-3 py-3">Garment</th>
                <th className="px-3 py-3">Work Type</th>
                <th className="px-3 py-3 text-right">Quantity Left</th>
                <th className="px-3 py-3 text-right">Your Payment</th>
                <th className="px-3 py-3">Deadline</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {d.todayJobs.map((j: any) => (
                <tr key={j.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3 font-semibold">{j.customer}</td>
                  <td className="px-3 py-3">{j.garment}{j.size && <span className="block text-xs font-semibold text-matesther-800">Size {j.size}</span>}{j.color && <span className="block text-xs text-slate-500">{j.color}</span>}</td>
                  <td className="px-3 py-3">{stageLabel(j.stage)} <span className="text-xs text-slate-400">({j.batchNumber})</span></td>
                  <td className="px-3 py-3 text-right font-bold">{j.quantityRemaining}</td>
                  <td className="px-3 py-3 text-right">{p?.paymentType === "PER_PIECE" ? `${naira(j.pieceRate ?? p.paymentRate)}/pc` : "Monthly salary"}</td>
                  <td className="px-3 py-3 text-xs">{fmtDate(j.expectedCompletionDate)}</td>
                  <td className="px-3 py-3">
                    <Badge status={j.status} />
                    {j.pendingInspection > 0 && (
                      <p className="text-[10px] text-violet-700 font-bold mt-0.5">{j.pendingInspection} with inspector</p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {["IN_PROGRESS", "SUBMITTED"].includes(j.status) && j.availableToSubmit > 0 && (
                      <Btn variant="secondary" onClick={() => { setSubmitErr(""); setQty(String(j.availableToSubmit)); setSubmit(j); }}>
                        Submit
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.todayJobs.length === 0 && <p className="p-5 text-sm text-slate-500">No active jobs right now.</p>}
        </div>
      </Card>

      <Modal open={!!submit} onClose={() => setSubmit(null)} title="Submit work for inspection">
        <form onSubmit={doSubmit} className="space-y-3">
          <p className="text-sm text-slate-600">
            <span className="font-semibold">{stageLabel(submit?.stage)}</span> - {submit?.batchNumber} ({submit?.orderNumber}).
            How many finished pieces are ready for inspection?
          </p>
          <Field label="Pieces ready *">
            <input type="number" min="1" max={submit?.availableToSubmit ?? 1} required value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
          </Field>
          {submitErr && <p className="text-sm text-red-600">{submitErr}</p>}
          <p className="text-xs text-slate-500">The Project Manager or Owner inspects the pieces and records approved / rework / rejected.</p>
          <div className="flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => setSubmit(null)}>Cancel</Btn>
            <Btn type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit for inspection"}</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
