"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, ClipboardCheck, HandCoins, History, ListFilter, Plus, ShieldCheck } from "lucide-react";
import { Card, CardHeader, PageHeader, Field, inputCls, Btn, Modal, Loading, EmptyState } from "@/components/ui";
import { naira, fmtDate } from "@/lib/format";
import { damageInspectionPayload } from "@/lib/payroll-incident-selection";

const monthNow = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const categories = ["Production Worker", "Support Worker", "Salaried / Non-Production Staff"];
const tabs = ["Records", "New deduction", "Payroll review", "Attendance", "Cooperative", "Reports", "Categories", "Audit"] as const;
type Tab = typeof tabs[number];
type PickedWorker = { id: number; name: string; department: string | null; specialty: string; paymentType?: string };

async function api<T = any>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: options?.method ?? "GET", cache: "no-store", credentials: "same-origin",
    headers: options?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not complete the request.");
  return result as T;
}

function WorkerPicker({ onChoose, selected = [] }: { onChoose: (person: PickedWorker) => void; selected?: number[] }) {
  const [search, setSearch] = useState("");
  const [deferred, setDeferred] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ rows: PickedWorker[]; total: number }>({ rows: [], total: 0 });
  const [error, setError] = useState("");
  useEffect(() => { const t = setTimeout(() => { setDeferred(search); setOffset(0); }, 250); return () => clearTimeout(t); }, [search]);
  useEffect(() => {
    let live = true;
    api<{ rows: PickedWorker[]; total: number }>(`/api/payroll-deductions/workers?search=${encodeURIComponent(deferred)}&limit=20&offset=${offset}`)
      .then((data) => { if (live) { setResult(data); setError(""); } })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [deferred, offset]);
  return <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
    <Field label="Find active worker by name or ID"><input className={inputCls} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search workers…" /></Field>
    {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
    <div className="mt-2 max-h-52 overflow-y-auto divide-y divide-slate-200">
      {result.rows.map((person) => <button type="button" key={person.id} onClick={() => onChoose(person)}
        className={`w-full min-h-11 px-2 text-left text-sm hover:bg-matesther-50 ${selected.includes(person.id) ? "font-bold text-matesther-800" : "text-slate-700"}`}>
        {person.name} <span className="text-xs font-normal text-slate-500">· {person.department || person.specialty} · {person.paymentType?.replace("_", " ")}</span>
        {selected.includes(person.id) ? " ✓" : ""}
      </button>)}
      {!result.rows.length && <p className="px-2 py-3 text-xs text-slate-500">No active workers match.</p>}
    </div>
    <div className="flex items-center justify-between pt-2 text-xs text-slate-500">
      <span>{result.total} match{result.total === 1 ? "" : "es"}</span>
      <span className="flex gap-2">
        <button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))} className="underline disabled:opacity-30">Previous</button>
        <button type="button" disabled={offset + 20 >= result.total} onClick={() => setOffset(offset + 20)} className="underline disabled:opacity-30">Next</button>
      </span>
    </div>
  </div>;
}

type Form = {
  categoryCode: string; description: string; method: string; basis: string; amount: string; rate: string;
  frequencyMonths: string; startMonth: string; endMonth: string; reference: string; authorityRef: string;
  evidenceRef: string; lateReason: string; consentRef: string; consentOn: string; attendanceId: string;
  workingDays: string; incidentKey: string; incidentQuantity: string; incidentLossAmount: string;
  incidentFindings: string; incidentLossBasis: string; annualGross: string; annualPension: string;
  annualNhf: string; annualNhis: string; annualRentPaid: string; annualOtherRelief: string;
  otherReliefBasis: string; minimumWageExempt: boolean;
};
const fresh = (): Form => ({
  categoryCode: "HOUSE_RENT", description: "", method: "FIXED", basis: "AFTER_SUPPORT", amount: "", rate: "",
  frequencyMonths: "0", startMonth: monthNow(), endMonth: "", reference: "", authorityRef: "", evidenceRef: "",
  lateReason: "", consentRef: "", consentOn: today(), attendanceId: "", workingDays: "",
  incidentKey: "", incidentQuantity: "", incidentLossAmount: "",
  incidentFindings: "", incidentLossBasis: "",
  annualGross: "", annualPension: "0", annualNhf: "0", annualNhis: "0", annualRentPaid: "0", annualOtherRelief: "0",
  otherReliefBasis: "", minimumWageExempt: false,
});

function FormField({ label, value, onChange, type = "text", required = false, min }: {
  label: string; value: string; onChange: (s: string) => void; type?: string; required?: boolean; min?: string;
}) {
  return <Field label={label}><input className={inputCls} type={type} value={value} min={min} required={required} onChange={(e) => onChange(e.target.value)} /></Field>;
}

export default function PayrollDeductionsPage() {
  const [tab, setTab] = useState<Tab>("Records");
  const [month, setMonth] = useState(monthNow());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form>(fresh);
  const set = (key: keyof Form, value: string | boolean) => setForm((f) => ({ ...f, [key]: value }));
  const [catalogue, setCatalogue] = useState<any>({ builtins: [], custom: [] });
  const [selectionType, setSelectionType] = useState("IDS");
  const [selected, setSelected] = useState<PickedWorker[]>([]);
  const [eligible, setEligible] = useState<PickedWorker[]>([]);
  const [department, setDepartment] = useState("");
  const [employmentCategory, setEmploymentCategory] = useState(categories[0]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [consents, setConsents] = useState<Record<number, { consentRef: string; consentOn: string }>>({});
  const [attendanceDays, setAttendanceDays] = useState<any[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [manualIncident, setManualIncident] = useState(false);
  const [manualSource, setManualSource] = useState<"STAGE" | "SUPPORT">("STAGE");
  const [records, setRecords] = useState<any>({ rows: [], total: 0 });
  const [recordStatus, setRecordStatus] = useState("");
  const [recordMonth, setRecordMonth] = useState("");
  const [recordPage, setRecordPage] = useState(0);
  const [reviewWorker, setReviewWorker] = useState<PickedWorker | null>(null);
  const [review, setReview] = useState<any>(null);
  const [ledger, setLedger] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [reportDept, setReportDept] = useState("");
  const [reportCategory, setReportCategory] = useState("");
  const [audit, setAudit] = useState<any[]>([]);
  const [reversals, setReversals] = useState<any[]>([]);
  const [attendanceWorker, setAttendanceWorker] = useState<PickedWorker | null>(null);
  const [attendanceForm, setAttendanceForm] = useState({ day: today(), status: "PRESENT", reason: "", evidenceRef: "" });
  const [editingDay, setEditingDay] = useState<number | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [decision, setDecision] = useState<{ type: "DEDUCTION" | "REVERSAL" | "REFUND" | "CATEGORY"; id: number; action: string; label: string; line?: any } | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [categoryName, setCategoryName] = useState("");

  const selectedCategory = form.categoryCode;
  const exceptional = ["STATUTORY_TAX", "ABSENCE", "DAMAGE"].includes(selectedCategory);
  const consentNeeded = !exceptional;
  const chosen = selectionType === "IDS" ? selected : eligible;
  const selectedId = selectionType === "IDS" && selected.length === 1 ? selected[0].id : null;
  const categoryOptions = useMemo(() => [
    ...(catalogue.builtins || []).map((item: any) => ({ value: item.code, label: item.name })),
    ...(catalogue.custom || []).filter((c: any) => c.active).map((c: any) => ({ value: `CUSTOM:${c.id}`, label: c.name })),
  ], [catalogue]);

  const showError = (e: unknown) => { setError(e instanceof Error ? e.message : "Request failed."); setMessage(""); };
  const loadCatalog = useCallback(() => api("/api/payroll-deductions/categories").then(setCatalogue).catch(showError), []);
  const loadRecords = useCallback(() => {
    const q = new URLSearchParams({ limit: "25", offset: String(recordPage * 25) });
    if (recordStatus) q.set("status", recordStatus);
    if (recordMonth) q.set("month", recordMonth);
    return api(`/api/payroll-deductions?${q}`).then(setRecords).catch(showError);
  }, [recordStatus, recordMonth, recordPage]);
  const loadReview = useCallback(() => {
    if (!reviewWorker) return;
    return api(`/api/payroll?month=${month}&workerId=${reviewWorker.id}`)
      .then((data: any) => setReview(data.history?.find((entry: any) => entry.month === month) ?? null)).catch(showError);
  }, [month, reviewWorker]);
  const loadLedger = useCallback(() => {
    if (!reviewWorker) return;
    return api(`/api/payroll-deductions/cooperative?workerId=${reviewWorker.id}`).then(setLedger).catch(showError);
  }, [reviewWorker]);
  const loadAttendance = useCallback(() => {
    if (!attendanceWorker) return;
    return api(`/api/payroll-deductions/attendance?month=${month}&workerId=${attendanceWorker.id}`).then((data: any) => setAttendanceDays(data.rows)).catch(showError);
  }, [attendanceWorker, month]);
  const loadReport = useCallback(() => {
    const q = new URLSearchParams({ view: "report", month });
    if (reportDept) q.set("department", reportDept);
    if (reportCategory) q.set("categoryCode", reportCategory);
    return api(`/api/payroll-deductions?${q}`).then(setReport).catch(showError);
  }, [month, reportDept, reportCategory]);
  useEffect(() => { loadCatalog(); api<any>("/api/payroll-deductions/workers?view=departments").then((d) => setDepartments(d.departments.filter(Boolean))).catch(showError); }, [loadCatalog]);
  useEffect(() => { if (tab === "Records") loadRecords(); }, [tab, loadRecords]);
  useEffect(() => { if (tab === "Payroll review") loadReview(); if (tab === "Cooperative") loadLedger(); }, [tab, loadReview, loadLedger]);
  useEffect(() => { if (tab === "Attendance") loadAttendance(); }, [tab, loadAttendance]);
  useEffect(() => { if (tab === "Reports") loadReport(); }, [tab, loadReport]);
  useEffect(() => { if (tab === "Audit") api<any>("/api/payroll-deductions?view=audit&limit=50").then((d) => setAudit(d.rows)).catch(showError); }, [tab]);
  useEffect(() => { if (tab === "Payroll review") api<any>("/api/payroll-deductions/reversals?limit=50").then((d) => setReversals(d.rows)).catch(showError); }, [tab, message]);
  useEffect(() => {
    if (selectedId === null) return;
    let live = true;
    if (selectedCategory === "ABSENCE") api<any>(`/api/payroll-deductions/attendance?month=${form.startMonth}&workerId=${selectedId}`)
      .then((d) => { if (live) setAttendanceDays(d.rows); }).catch(showError);
    if (selectedCategory === "DAMAGE") api<any>(`/api/payroll-deductions/incidents?workerId=${selectedId}`)
      .then((d) => { if (live) setIncidents(d.rows); }).catch(showError);
    return () => { live = false; };
  }, [selectedCategory, selectedId, form.startMonth]);

  function go(next: Tab) { setTab(next); setError(""); setMessage(""); }
  function pick(person: PickedWorker) {
    setAttendanceDays([]); setIncidents([]);
    setForm((old) => ({ ...old, attendanceId: "", incidentKey: "" }));
    setManualIncident(false);
    setSelected((old) => old.some((p) => p.id === person.id) ? old.filter((p) => p.id !== person.id) : [...old, person]);
  }
  async function previewGroup() {
    setError(""); setEligible([]);
    try {
      const q = new URLSearchParams({ view: "eligible", type: selectionType,
        department, category: employmentCategory });
      const data = await api<{ rows: PickedWorker[]; count: number }>(`/api/payroll-deductions/workers?${q}`);
      setEligible(data.rows);
      setMessage(`${data.count} eligible active worker${data.count === 1 ? "" : "s"}. Separate consent is required for EACH person below.`);
    } catch (e) { showError(e); }
  }
  async function saveDeduction(e: React.FormEvent) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      if (!chosen.length) throw new Error("Select or preview eligible workers first.");
      if (exceptional && (selectionType !== "IDS" || chosen.length !== 1))
        throw new Error("Tax, absence and damage are individual, independently reviewed cases.");
      // A picker value includes its source: stage and support inspection IDs
      // can overlap. Never send both keys (or a stale source from another worker).
      const { incidentKey, ...terms } = form;
      const body: any = {
        ...terms,
        ...(selectedCategory === "DAMAGE" ? damageInspectionPayload(incidentKey) : {}),
        frequencyMonths: Number(form.frequencyMonths),
        endMonth: form.endMonth || null,
        selection: selectionType === "IDS" ? { type: "IDS", workerIds: chosen.map((p) => p.id) } :
          { type: selectionType, department, category: employmentCategory },
      };
      if (form.method === "PERCENT") body.rateBps = Math.round(Number(form.rate) * 100);
      if (chosen.length > 1 || selectionType !== "IDS")
        body.consents = chosen.map((p) => ({ workerId: p.id, ...consents[p.id] }));
      const result = await api<any>("/api/payroll-deductions", { method: "POST", body });
      setMessage(`${result.count} pending proposal${result.count === 1 ? "" : "s"} created. Review/approve before any money moves.`);
      setForm(fresh()); setManualIncident(false); setSelected([]); setEligible([]); setConsents({}); setTab("Records"); loadRecords();
    } catch (err) { showError(err); } finally { setBusy(false); }
  }
  async function sendDecision(e: React.FormEvent) {
    e.preventDefault(); if (!decision) return;
    setBusy(true); setError("");
    try {
      if (decision.type === "REFUND") {
        await api("/api/payroll-deductions/reversals", { method: "POST", body: {
          sourceLineId: decision.id, targetMonth: monthNow(), reason: decisionReason,
        } });
      } else if (decision.type === "CATEGORY") {
        await api("/api/payroll-deductions/categories", { method: "PUT", body: {
          id: decision.id, reason: decisionReason,
          ...(decision.action === "RENAME" ? { name: categoryName } : { active: decision.action === "ACTIVATE" }),
        } });
        loadCatalog();
      } else {
        await api(decision.type === "REVERSAL" ? "/api/payroll-deductions/reversals" : "/api/payroll-deductions", {
          method: "PUT", body: { id: decision.id, action: decision.action, reason: decisionReason },
        });
        loadRecords(); loadReview(); loadLedger();
      }
      setMessage(`${decision.action.toLowerCase()} recorded with your reason and timestamp.`);
      setDecision(null); setDecisionReason("");
    } catch (err) { showError(err); } finally { setBusy(false); }
  }
  function openDecision(type: NonNullable<typeof decision>["type"], id: number, action: string, label: string) {
    setDecision({ type, id, action, label }); setDecisionReason(""); setError("");
  }
  async function post() {
    if (!reviewWorker) return;
    setBusy(true); setError("");
    try {
      await api("/api/payroll-deductions/post", { method: "POST", body: { workerId: reviewWorker.id, month } });
      setMessage(`Payroll for ${reviewWorker.name} · ${month} is posted. The statement and cooperative credit are now immutable.`);
      loadReview(); loadLedger(); loadRecords();
    } catch (err) { showError(err); } finally { setBusy(false); }
  }
  async function saveAttendance(e: React.FormEvent) {
    e.preventDefault(); if (!attendanceWorker) return;
    setBusy(true); setError("");
    try {
      await api("/api/payroll-deductions/attendance", { method: editingDay ? "PUT" : "POST",
        body: { ...attendanceForm, ...(editingDay ? { id: editingDay } : { workerId: attendanceWorker.id }) } });
      setMessage(editingDay ? "Attendance corrected; original values remain in the audit trail." : "Day recorded; no deduction is created automatically.");
      setAttendanceForm({ day: today(), status: "PRESENT", reason: "", evidenceRef: "" }); setEditingDay(null);
      loadAttendance();
    } catch (err) { showError(err); } finally { setBusy(false); }
  }
  async function addCategory(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await api("/api/payroll-deductions/categories", { method: "POST", body: { name: newCategory } });
      setMessage("Custom category created; company deductions still need consent and a lawful basis.");
      setNewCategory(""); loadCatalog();
    } catch (err) { showError(err); } finally { setBusy(false); }
  }

  return <div>
    <PageHeader title="Payroll Deductions" subtitle="Separate approved deductions from earned pay. Propose → review → preview → post a completed payroll month → settle net pay. No inspection failure or missing day is charged automatically."
      action={<Btn href="/payroll" variant="secondary"><HandCoins className="w-4 h-4" /> Worker Payments</Btn>} />
    <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Payroll deductions sections">
      {tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} onClick={() => go(name)}
        className={`rounded-lg px-3 py-2 text-xs sm:text-sm font-semibold border min-h-11 ${tab === name ? "border-matesther-800 bg-matesther-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-matesther-50"}`}>{name}</button>)}
    </div>
    {error && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
    {message && <div role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{message}</div>}

    {tab === "Records" && <Card>
      <CardHeader title="Worker deduction records" subtitle="Pending proposals cannot change pay. Posted lines survive cancellations and appear on each worker's statement."
        action={<Btn onClick={() => go("New deduction")}><Plus className="w-4 h-4" /> New deduction</Btn>} />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <Field label="Status"><select className={inputCls} value={recordStatus} onChange={(e) => { setRecordStatus(e.target.value); setRecordPage(0); }}>
          <option value="">All statuses</option>{["PENDING", "APPROVED", "CANCELLED", "REJECTED"].map((s) => <option key={s}>{s}</option>)}
        </select></Field>
        <Field label="Month within start/end window (optional)"><input className={inputCls} type="month" value={recordMonth} onChange={(e) => { setRecordMonth(e.target.value); setRecordPage(0); }} /></Field>
        <div className="self-end text-xs text-slate-500">{records.total} records · {recordPage * 25 + 1}–{Math.min((recordPage + 1) * 25, records.total)} shown</div>
      </div>
      {records.rows.length ? <div className="divide-y divide-slate-100">
        {records.rows.map(({ deduction: d, workerName }: any) => <div key={d.id} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
          <div className="flex-1 min-w-52">
            <p className="font-semibold text-slate-900">{workerName} · {d.categoryName} <span className={`ml-1 text-xs ${d.status === "APPROVED" ? "text-emerald-700" : "text-amber-700"}`}>{d.status}</span></p>
            <p className="text-slate-600">{d.description} · {d.method === "PERCENT" ? `${d.rateBps / 100}% of ${d.basis.toLowerCase()}` : d.method === "PAYE_2026" ? "Progressive Nigerian PAYE" : d.method === "ATTENDANCE" ? "Monthly salary ÷ policy days" : naira(d.amount || 0)}</p>
            <p className="text-xs text-slate-500">{d.startMonth}{d.frequencyMonths ? ` · every ${d.frequencyMonths} month(s)${d.endMonth ? ` until ${d.endMonth}` : ""}` : " · once"} · Ref {d.reference} · proposed by {d.createdByName}
              {d.approvedByName ? ` · reviewed by ${d.approvedByName}` : ""}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {d.status === "PENDING" && <>
              <Btn variant="secondary" onClick={() => openDecision("DEDUCTION", d.id, "APPROVE", `${workerName} · ${d.categoryName}`)}>Approve</Btn>
              <Btn variant="ghost" onClick={() => openDecision("DEDUCTION", d.id, "REJECT", `${workerName} · ${d.categoryName}`)}>Reject</Btn>
            </>}
            {["PENDING", "APPROVED"].includes(d.status) && <Btn variant="ghost" onClick={() => openDecision("DEDUCTION", d.id, "CANCEL", `${workerName} · ${d.categoryName}`)}>Cancel future</Btn>}
            <Btn variant="ghost" onClick={() => { setReviewWorker({ id: d.workerId, name: workerName, department: null, specialty: "" }); setMonth(d.startMonth); go("Payroll review"); }}>Preview pay</Btn>
          </div>
        </div>)}
      </div> : <EmptyState title="No proposals match" hint="Create a documented proposal or change the filters." />}
      <div className="flex justify-between px-4 py-3 border-t border-slate-100">
        <Btn variant="secondary" disabled={recordPage === 0} onClick={() => setRecordPage(recordPage - 1)}>Previous</Btn>
        <Btn variant="secondary" disabled={(recordPage + 1) * 25 >= records.total} onClick={() => setRecordPage(recordPage + 1)}>Next</Btn>
      </div>
    </Card>}

    {tab === "New deduction" && <Card className="p-4 sm:p-5">
      <h2 className="text-lg font-bold mb-1">New worker deduction proposal</h2>
      <p className="text-sm text-slate-600 mb-4">No bulk consent shortcut. Tax, unpaid leave and damage require an individual case. The signed reference and legal basis must exist outside this form.</p>
      <form onSubmit={saveDeduction} className="grid gap-4 sm:grid-cols-2">
        <Field label="Category *"><select className={inputCls} value={form.categoryCode} onChange={(e) => {
          const code = e.target.value;
          setForm((f) => ({ ...f, categoryCode: code, method: code === "STATUTORY_TAX" ? "PAYE_2026" : code === "ABSENCE" ? "ATTENDANCE" : "FIXED",
            frequencyMonths: code === "STATUTORY_TAX" ? "1" : "0", endMonth: code === "STATUTORY_TAX" ? "2026-12" : "",
            attendanceId: "", incidentKey: "" }));
          setManualIncident(false);
        }}>{categoryOptions.map((item: any) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
        {!exceptional && <Field label="Calculation *"><select className={inputCls} value={form.method} onChange={(e) => set("method", e.target.value)}>
          <option value="FIXED">Fixed amount</option><option value="PERCENT">Percentage of pay or salary</option><option value="VARIABLE">Variable, one-time (independent review)</option>
        </select></Field>}
        <FormField label="Description / purpose *" value={form.description} onChange={(v) => set("description", v)} required />
        <FormField label="Unique agreement / incident reference *" value={form.reference} onChange={(v) => set("reference", v)} required />
        {form.method === "PERCENT" ? <>
          <FormField label="Percent (e.g. 2.5) *" type="number" min="0.01" value={form.rate} onChange={(v) => set("rate", v)} required />
          <Field label="Percent of"><select className={inputCls} value={form.basis} onChange={(e) => set("basis", e.target.value)}><option value="AFTER_SUPPORT">Approved earnings after helper share</option><option value="SALARY">Monthly salary only</option></select></Field>
        </> : ["FIXED", "VARIABLE"].includes(form.method) ? <FormField label="Deduction amount (₦) *" type="number" min="1" value={form.amount} onChange={(v) => set("amount", v)} required /> : null}
        <FormField label="Start payroll month *" type="month" value={form.startMonth} onChange={(v) => set("startMonth", v)} required />
        {!exceptional && <>
          <Field label="Frequency (0 = once)"><select className={inputCls} value={form.frequencyMonths} onChange={(e) => set("frequencyMonths", e.target.value)}>
            <option value="0">One time</option>{Array.from({ length: 12 }, (_, i) => i + 1).map((v) => <option key={v} value={v}>Every {v} month{v === 1 ? "" : "s"}</option>)}
          </select></Field>
          {form.frequencyMonths !== "0" && <FormField label="End month (blank = until cancelled)" type="month" value={form.endMonth} onChange={(v) => set("endMonth", v)} />}
        </>}
        {form.startMonth < monthNow() && <FormField label="Reason for prior, unpaid month *" value={form.lateReason} onChange={(v) => set("lateReason", v)} required />}
        {selectedCategory === "STATUTORY_TAX" && <>
          <p className="sm:col-span-2 rounded-lg bg-blue-50 p-3 text-xs text-blue-900">2026 law only. An Owner must verify each worker&apos;s annual taxable income, pension/NHF/NHIS and actual paid rent (20% relief capped at ₦500,000). No tax is applied without a separately approved assessment. A different Owner must approve.</p>
          <FormField label="Assessed annual gross (₦) *" type="number" value={form.annualGross} onChange={(v) => set("annualGross", v)} required />
          {(["annualPension", "annualNhf", "annualNhis", "annualRentPaid", "annualOtherRelief"] as const).map((key) =>
            <FormField key={key} label={`${key.replace("annual", "Verified annual ")} (₦)`} type="number" min="0" value={form[key]} onChange={(v) => set(key, v)} />)}
          {Number(form.annualOtherRelief) > 0 && <FormField label="Statutory basis for other relief *" value={form.otherReliefBasis} onChange={(v) => set("otherReliefBasis", v)} required />}
          <label className="sm:col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.minimumWageExempt} onChange={(e) => set("minimumWageExempt", e.target.checked)} /> Evidenced employee earning statutory minimum wage (≤ ₦70,000/month)</label>
        </>}
        {selectedCategory === "DAMAGE" && <>
          <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-950">A failed inspection is NOT a debt. Only rejected (not rework) pieces, established worker responsibility, proven remaining net loss AFTER withheld piecework, prior written labour-officer consent, and an independent Owner review permit a charge.</p>
          <Field label="Rejected stage or support-work inspection *"><select className={inputCls}
            value={manualIncident ? "MANUAL" : form.incidentKey}
            onChange={(e) => {
              const value = e.target.value;
              setManualIncident(value === "MANUAL");
              set("incidentKey", value === "MANUAL" ? "" : value);
            }} required>
            <option value="">Choose a rejected inspection…</option>
            {incidents.map((i) => <option key={`${i.source}:${i.id}`} value={`${i.source}:${i.id}`}>
              {i.source === "SUPPORT" ? "Support" : "Stage"} #{i.id} · {i.orderNumber} · {i.stage}
              {i.operation ? ` · ${i.operation}` : ""} · {i.quantityRejected} rejected
            </option>)}
            <option value="MANUAL">Older inspection: enter its source and ID…</option>
          </select></Field>
          {manualIncident && <>
            <Field label="Older inspection source *"><select className={inputCls} value={manualSource} onChange={(e) => {
              setManualSource(e.target.value as "STAGE" | "SUPPORT"); set("incidentKey", "");
            }}><option value="STAGE">Stage inspection</option><option value="SUPPORT">Support-work inspection</option></select></Field>
            <FormField label="Older rejected inspection ID *" type="number" min="1"
              value={form.incidentKey.split(":")[1] || ""}
              onChange={(v) => set("incidentKey", v ? `${manualSource}:${v}` : "")} required />
          </>}
          <p className="sm:col-span-2 text-xs text-slate-500">The latest 100 rejected inspections for this worker are shown. An older ID is checked against this worker and its source on the server.</p>
          <FormField label="Responsible rejected quantity *" type="number" value={form.incidentQuantity} onChange={(v) => set("incidentQuantity", v)} required />
          <FormField label="Proven NET loss after withheld earnings (₦) *" type="number" value={form.incidentLossAmount} onChange={(v) => set("incidentLossAmount", v)} required />
          <FormField label="Finding of wilful misconduct / neglect *" value={form.incidentFindings} onChange={(v) => set("incidentFindings", v)} required />
          <FormField label="How was remaining loss calculated? *" value={form.incidentLossBasis} onChange={(v) => set("incidentLossBasis", v)} required />
        </>}
        {selectedCategory === "ABSENCE" && <>
          <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-950">Only an explicitly recorded UNPAID_LEAVE or UNAUTHORIZED_ABSENCE for a monthly-paid worker can affect salary. Paid/approved leave and missing attendance rows never produce charges.</p>
          <Field label="Recorded unpaid day *"><select className={inputCls} value={form.attendanceId} onChange={(e) => set("attendanceId", e.target.value)} required>
            <option value="">Choose an unpaid day from Attendance…</option>{attendanceDays.filter((a) => ["UNPAID_LEAVE", "UNAUTHORIZED_ABSENCE"].includes(a.status)).map((a) =>
              <option key={a.id} value={a.id}>{a.day} · {a.status.replaceAll("_", " ")} · {a.reason}</option>)}
          </select></Field>
          <FormField label="Documented payable working days this month (1–31) *" type="number" min="1" value={form.workingDays} onChange={(v) => set("workingDays", v)} required />
        </>}
        <FormField label={selectedCategory === "DAMAGE" ? "Prior written labour-officer approval reference *" : selectedCategory === "COOPERATIVE" ? "Approved cooperative scheme reference *" : "Lawful basis / scheme authorisation reference *"}
          value={form.authorityRef} onChange={(v) => set("authorityRef", v)} required={selectedCategory !== "STATUTORY_TAX"} />
        <FormField label={exceptional ? "Case / assessment / policy evidence reference *" : "Supporting evidence reference"} value={form.evidenceRef} onChange={(v) => set("evidenceRef", v)} required={exceptional} />
        <div className="sm:col-span-2 border-t border-slate-100 pt-4">
          <h3 className="font-semibold text-sm mb-2">Affected worker{chosen.length === 1 ? "" : "s"}</h3>
          <Field label="Selection"><select className={inputCls} value={selectionType} onChange={(e) => {
            setSelectionType(e.target.value); setEligible([]); setAttendanceDays([]); setIncidents([]);
            setForm((old) => ({ ...old, attendanceId: "", incidentKey: "" })); setManualIncident(false);
          }}>
            <option value="IDS">Individual / selected workers</option><option value="ALL">All active workers</option>
            <option value="DEPARTMENT">By department</option><option value="EMPLOYMENT_CATEGORY">By employment category</option>
          </select></Field>
          {selectionType === "IDS" ? <>
            <div className="my-3"><WorkerPicker onChoose={pick} selected={selected.map((p) => p.id)} /></div>
            <p className="text-xs text-slate-500">Selected: {selected.map((w) => w.name).join(", ") || "none"} · tap again to remove.</p>
          </> : <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {selectionType === "DEPARTMENT" && <Field label="Department"><select className={inputCls} value={department} onChange={(e) => { setDepartment(e.target.value); setEligible([]); }}><option value="">Choose…</option>{departments.map((d) => <option key={d}>{d}</option>)}</select></Field>}
            {selectionType === "EMPLOYMENT_CATEGORY" && <Field label="Employment category"><select className={inputCls} value={employmentCategory} onChange={(e) => { setEmploymentCategory(e.target.value); setEligible([]); }}>{categories.map((c) => <option key={c}>{c}</option>)}</select></Field>}
            <Btn variant="secondary" onClick={previewGroup}><ListFilter className="w-4 h-4" /> Preview eligible workers</Btn>
          </div>}
        </div>
        {consentNeeded && chosen.length === 1 && selectionType === "IDS" && <>
          <FormField label="This worker's written consent / agreement reference *" value={form.consentRef} onChange={(v) => set("consentRef", v)} required />
          <FormField label="Worker consent date *" type="date" value={form.consentOn} onChange={(v) => set("consentOn", v)} required />
        </>}
        {consentNeeded && (chosen.length > 1 || selectionType !== "IDS") && <div className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-950">Separate written consent for every selected worker</p>
          <p className="text-xs text-amber-900 mb-3">The API refuses the entire group if even one worker lacks their own authorisation. No shared consent is invented.</p>
          <div className="grid gap-3 max-h-72 overflow-y-auto">
            {chosen.map((person) => <div key={person.id} className="rounded-lg bg-white p-2 grid gap-2 sm:grid-cols-3">
              <span className="text-sm font-semibold self-center">{person.name}</span>
              <input aria-label={`Consent reference for ${person.name}`} className={inputCls} required placeholder="Signed reference *" value={consents[person.id]?.consentRef ?? ""}
                onChange={(e) => setConsents((old) => ({ ...old, [person.id]: { consentRef: e.target.value, consentOn: old[person.id]?.consentOn ?? today() } }))} />
              <input aria-label={`Consent date for ${person.name}`} className={inputCls} type="date" required value={consents[person.id]?.consentOn ?? today()}
                onChange={(e) => setConsents((old) => ({ ...old, [person.id]: { consentRef: old[person.id]?.consentRef ?? "", consentOn: e.target.value } }))} />
            </div>)}
          </div>
        </div>}
        <div className="sm:col-span-2 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
          <p className="mr-auto text-xs text-slate-500">Draft → review (a different Owner for tax, damage, absence, variable or custom) → preview → post.</p>
          <Btn disabled={busy || !chosen.length} type="submit"><Plus className="w-4 h-4" /> {busy ? "Saving…" : `Create ${chosen.length || ""} proposal${chosen.length === 1 ? "" : "s"}`}</Btn>
        </div>
      </form>
    </Card>}

    {tab === "Payroll review" && <div className="space-y-4">
      <Card className="p-4 sm:p-5"><div className="grid gap-3 md:grid-cols-2">
        <Field label="Payroll period"><input className={inputCls} type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <p className="self-end text-sm text-slate-600">Post only after month end. A posted statement cannot be overwritten; cash payments are recorded separately under Worker Payments.</p>
      </div>
        <div className="mt-3"><WorkerPicker onChoose={(person) => { setReviewWorker(person); setLedger(null); }} selected={reviewWorker ? [reviewWorker.id] : []} /></div>
      </Card>
      {reviewWorker && !review && <Loading label="Loading worker's 12-month payroll…" />}
      {review && <Card>
        <CardHeader title={`${reviewWorker?.name} · ${month}`} subtitle={review.finalized ? `POSTED statement #${review.statementId} · ${fmtDate(review.postedAt)}` : review.mustPost ? "PREVIEW — not payable until this period is posted" : "Existing payroll rule; no new deduction to post"} />
        <div className="p-4 space-y-3">
          <div className="grid gap-2 sm:grid-cols-4 text-sm">
            <div>Gross earnings <strong className="block">{naira(review.gross)}</strong><small>Salary {naira(review.salary)} · production {naira(review.piecework)} · support {naira(review.supportPiecework)} · overtime/other {naira(review.overtime + review.other)}</small></div>
            <div>Support share <strong className="block">−{naira(review.supportDeduction)}</strong><small>Already allocated to the helper on approved work only</small></div>
            <div>PAYE + other <strong className="block">{review.payrollDeductions < 0 ? `+${naira(-review.payrollDeductions)} refund` : `−${naira(review.payrollDeductions)}`}</strong><small>Statutory {naira(review.taxDeduction)} · other {naira(review.payrollDeductions - review.taxDeduction)}</small></div>
            <div>Net payable <strong className="block text-matesther-800 text-lg">{naira(review.due)}</strong><small>Paid {naira(review.paid)} · balance {naira(review.balance)} · {review.paymentStatus}</small></div>
          </div>
          {review.previewIssues?.map((issue: string, i: number) => <p key={i} className="rounded-lg bg-red-50 p-3 text-sm text-red-800">Cannot post: {issue}</p>)}
          {review.deductionItems?.length > 0 ? <div className="border-t border-slate-100 pt-3">
            <h3 className="text-sm font-semibold mb-2">Itemized deduction / credit history</h3>
            {review.deductionItems.map((item: any) => <div key={`${item.deductionId ?? "refund"}-${item.id}`} className="flex justify-between gap-3 border-b border-slate-100 py-2 text-xs sm:text-sm">
              <div><strong>{item.categoryName}</strong> · {item.description}<p className="text-slate-500">{item.calculation}</p>
                {item.cooperativeCredit !== 0 && <p className="text-emerald-700">Cooperative balance {item.cooperativeCredit > 0 ? "credited" : "debited"} {naira(Math.abs(item.cooperativeCredit))}</p>}</div>
              <div className="text-right whitespace-nowrap"><strong>{item.amount < 0 ? `+${naira(-item.amount)} refund` : `−${naira(item.amount)}`}</strong>
                {review.finalized && item.amount > 0 && item.categoryCode !== "STATUTORY_TAX" &&
                  <button type="button" className="block text-amber-800 underline text-xs" onClick={() => openDecision("REFUND", item.id, "REFUND", item.categoryName)}>Request refund</button>}
              </div>
            </div>)}
          </div> : <p className="text-xs text-slate-500">No statutory/company deductions configured for this worker/month.</p>}
          {!review.finalized && <Btn disabled={busy || month >= monthNow() || review.paid > 0 || review.previewIssues?.length > 0}
            onClick={post}><BadgeCheck className="w-4 h-4" /> {busy ? "Posting…" : "Post completed month"}</Btn>}
        </div>
      </Card>}
      <Card><CardHeader title="Refund / correction requests" subtitle="Approved by a different Owner; a booked refund is an extra amount payable in a later month, not a rewrite of the old statement." />
        <div className="divide-y divide-slate-100">{reversals.map(({ reversal: r, workerName, categoryName, sourcePeriod }: any) => <div key={r.id} className="p-3 text-sm flex flex-wrap justify-between gap-2">
          <div><strong>{workerName}</strong> · {categoryName} · {naira(r.amount)}<p className="text-xs text-slate-500">From {sourcePeriod} → {r.targetMonth} · {r.status} · {r.reason}</p></div>
          {r.status === "PENDING" && <span className="flex gap-1"><Btn variant="secondary" onClick={() => openDecision("REVERSAL", r.id, "APPROVE", categoryName)}>Approve</Btn><Btn variant="ghost" onClick={() => openDecision("REVERSAL", r.id, "REJECT", categoryName)}>Reject</Btn></span>}
          {r.status === "APPROVED" && <Btn variant="ghost" onClick={() => openDecision("REVERSAL", r.id, "CANCEL", categoryName)}>Cancel if unposted</Btn>}
        </div>)}{!reversals.length && <EmptyState title="No correction requests" />}</div>
      </Card>
    </div>}

    {tab === "Attendance" && <div className="grid gap-4 xl:grid-cols-2">
      <Card className="p-4"><h2 className="font-semibold mb-2">Record an actual day</h2><p className="mb-3 text-xs text-slate-500">Missing dates, weekends and approved/paid leave are never automatically deducted.</p>
        <WorkerPicker onChoose={(person) => { setAttendanceWorker(person); setAttendanceDays([]); setEditingDay(null); }} selected={attendanceWorker ? [attendanceWorker.id] : []} />
        {attendanceWorker && <form onSubmit={saveAttendance} className="mt-4 grid gap-3">
          <p className="text-sm font-semibold">{attendanceWorker.name}{editingDay ? ` · correct day #${editingDay}` : ""}</p>
          {editingDay ? <Field label="Day (fixed; create a new record to change the date)"><input className={inputCls} type="date" value={attendanceForm.day} disabled /></Field>
            : <FormField label="Day *" type="date" value={attendanceForm.day} onChange={(v) => setAttendanceForm((f) => ({ ...f, day: v }))} required />}
          <Field label="Situation"><select className={inputCls} value={attendanceForm.status} onChange={(e) => setAttendanceForm((f) => ({ ...f, status: e.target.value }))}>
            {["PRESENT", "UNAUTHORIZED_ABSENCE", "UNPAID_LEAVE", "APPROVED_LEAVE", "PAID_LEAVE", "OTHER"].map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
          </select></Field>
          <FormField label="Reason / leave outcome *" value={attendanceForm.reason} onChange={(v) => setAttendanceForm((f) => ({ ...f, reason: v }))} required />
          <FormField label="Evidence / approved leave reference (required for unpaid)" value={attendanceForm.evidenceRef} onChange={(v) => setAttendanceForm((f) => ({ ...f, evidenceRef: v }))} />
          <div className="flex gap-2"><Btn type="submit" disabled={busy}><ClipboardCheck className="w-4 h-4" /> {editingDay ? "Audit correction" : "Record day"}</Btn>
            {editingDay && <Btn variant="secondary" onClick={() => { setEditingDay(null); setAttendanceForm({ day: today(), status: "PRESENT", reason: "", evidenceRef: "" }); }}>Cancel edit</Btn>}</div>
        </form>}
      </Card>
      <Card><CardHeader title={`Recorded situations · ${month}`} action={<input aria-label="Attendance month" className={inputCls} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />} />
        <div className="divide-y divide-slate-100">{attendanceDays.map((a) => <div className="p-3 text-sm" key={a.id}>
          <div className="flex justify-between gap-2"><strong>{a.day} · {a.status.replaceAll("_", " ")}</strong><button className="underline text-xs text-matesther-800" onClick={() => { setAttendanceWorker((prev) => prev ?? { id: a.workerId, name: "Worker", department: null, specialty: "" }); setEditingDay(a.id); setAttendanceForm({ day: a.day, status: a.status, reason: a.reason, evidenceRef: a.evidenceRef || "" }); }}>Correct</button></div>
          <p className="text-xs text-slate-500">{a.reason} · {a.evidenceRef || "no attachment reference"} · by {a.recordedByName}</p>
        </div>)}{!attendanceDays.length && <EmptyState title="No recorded days this month" hint="An empty day is NOT an absence." />}</div>
      </Card>
    </div>}

    {tab === "Cooperative" && <div className="space-y-4"><Card className="p-4"><h2 className="font-semibold mb-2">Member balance and transactions</h2>
      <p className="text-sm text-slate-600 mb-3">Only posted payroll lines are credited; a refund posts a matching debit. These are neither company revenue nor an expense.</p>
      <WorkerPicker onChoose={(p) => { setReviewWorker(p); setLedger(null); }} selected={reviewWorker ? [reviewWorker.id] : []} />
    </Card>{ledger && <Card><CardHeader title={`${reviewWorker?.name} · cooperative balance ${naira(ledger.balance)}`} subtitle={`${ledger.total} posted transaction${ledger.total === 1 ? "" : "s"}`} />
      <div className="divide-y divide-slate-100">{ledger.transactions.map(({ line, periodMonth, postedAt }: any) => <div key={line.id} className="p-3 text-sm flex justify-between gap-3">
        <div><strong>{periodMonth}</strong> · {line.description}<p className="text-xs text-slate-500">{line.calculation} · posted {fmtDate(postedAt)}</p></div>
        <strong className={line.cooperativeCredit < 0 ? "text-red-700" : "text-emerald-700"}>{line.cooperativeCredit > 0 ? "+" : ""}{naira(line.cooperativeCredit)}</strong>
      </div>)}{!ledger.transactions.length && <EmptyState title="No posted savings" hint="An approved proposal is not a credit until payroll is posted." />}</div>
    </Card>}</div>}

    {tab === "Reports" && <Card><CardHeader title="Posted deduction report" subtitle="Only posted lines, including signed refunds; not pending or hypothetical deductions." />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <Field label="Payroll period"><input className={inputCls} type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <Field label="Department"><select className={inputCls} value={reportDept} onChange={(e) => setReportDept(e.target.value)}><option value="">All departments</option>{departments.map((d) => <option key={d}>{d}</option>)}</select></Field>
        <Field label="Category"><select className={inputCls} value={reportCategory} onChange={(e) => setReportCategory(e.target.value)}><option value="">All categories</option>{categoryOptions.map((c: any) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field>
      </div>
      {report ? <div className="px-4 pb-4 space-y-5">
        <div className="grid gap-3 md:grid-cols-3">{(["byCategory", "byDepartment", "byWorker"] as const).map((key) => <div key={key} className="rounded-lg bg-slate-50 p-3">
          <h3 className="text-xs uppercase font-semibold text-slate-500 mb-2">{key.replace("by", "By ")}</h3>
          {report[key]?.map((r: any) => <p key={r.label} className="flex justify-between border-b border-slate-200 py-1 text-xs gap-2"><span>{key === "byWorker" ? report.rows.find((row: any) => String(row.workerId) === r.label)?.workerName || r.label
                : key === "byCategory" ? report.rows.find((row: any) => row.categoryCode === r.label)?.categoryName || r.label : r.label}</span><strong>{naira(r.amount)}</strong></p>)}
          {!report[key]?.length && <p className="text-xs text-slate-500">No posted lines.</p>}
        </div>)}</div>
        <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-sm"><thead><tr className="text-left text-xs uppercase border-b"><th className="p-2">Worker</th><th className="p-2">Department</th><th className="p-2">Category</th><th className="p-2 text-right">Deducted (refunds negative)</th><th className="p-2 text-right">Savings credited</th></tr></thead>
          <tbody>{report.rows.map((r: any, i: number) => <tr key={i} className="border-b border-slate-100"><td className="p-2">{r.workerName}</td><td className="p-2">{r.department || "—"}</td><td className="p-2">{r.categoryName}</td><td className="p-2 text-right">{naira(Number(r.amount))}</td><td className="p-2 text-right">{naira(Number(r.cooperativeCredit))}</td></tr>)}</tbody></table></div>
      </div> : <Loading />}
    </Card>}

    {tab === "Categories" && <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader title="Built-in categories" subtitle="Statutory PAYE is separate from company deductions. These rules cannot be renamed into another type." />
        <div className="divide-y divide-slate-100">{catalogue.builtins?.map((c: any) => <div key={c.code} className="p-3 text-sm"><strong>{c.name}</strong><p className="text-xs text-slate-500">{c.code} · {c.kind}</p></div>)}</div>
      </Card><Card className="p-4"><h2 className="font-semibold mb-2">Company-defined categories</h2>
        <form onSubmit={addCategory} className="flex flex-wrap gap-2"><input className={`${inputCls} flex-1 min-w-44`} placeholder="e.g. Optional welfare fund" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} required /><Btn type="submit" disabled={busy}>Add category</Btn></form>
        <p className="text-xs text-slate-500 mt-2">Retiring a category prevents new proposals, not an existing signed agreement. Cancel those individually.</p>
        {catalogue.custom?.map((c: any) => <div key={c.id} className="border-b border-slate-100 py-3 flex justify-between gap-2 text-sm"><div><strong>{c.name}</strong> <span className="text-xs text-slate-500">{c.active ? "Active" : "Retired"}</span></div><div className="flex gap-2"><button className="text-xs underline" onClick={() => { setCategoryName(c.name); openDecision("CATEGORY", c.id, "RENAME", c.name); }}>Rename</button><button className="text-xs underline" onClick={() => openDecision("CATEGORY", c.id, c.active ? "RETIRE" : "ACTIVATE", c.name)}>{c.active ? "Retire" : "Activate"}</button></div></div>)}
      </Card>
    </div>}

    {tab === "Audit" && <Card><CardHeader title="Deduction decision history" subtitle="Append-only names, times, reasons, old and new values; prior posted payroll cannot be overwritten." action={<History className="w-5 h-5 text-matesther-700" />} />
      <div className="divide-y divide-slate-100">{audit.map((entry: any) => <div key={entry.id} className="px-4 py-3 text-sm"><strong>{entry.action}</strong> · {entry.entityType} #{entry.entityId} · {entry.actorName}
        <p className="text-xs text-slate-600">{entry.reason}</p><p className="text-[11px] text-slate-400">{fmtDate(entry.createdAt)}</p>
      </div>)}{!audit.length && <EmptyState title="No decisions recorded" />}</div>
    </Card>}

    <Modal open={!!decision} title={decision ? `${decision.action}: ${decision.label}` : ""} onClose={() => setDecision(null)}>
      {decision && <form onSubmit={sendDecision} className="space-y-4">
        {decision.type === "REFUND" && <p className="text-xs text-amber-900 rounded bg-amber-50 p-3">This proposes a full refund in {monthNow()} for independent Owner approval. The original posted item remains unchanged. PAYE cannot be refunded through this route.</p>}
        {decision.action === "APPROVE" && <p className="text-xs text-slate-600">Tax, damaged garments, unauthorized absences, variable cases, custom categories and refunds require review by an Owner OTHER than the proposer. Backend permissions always enforce this.</p>}
        {decision.action === "RENAME" && <FormField label="New category name *" value={categoryName} onChange={setCategoryName} required />}
        <Field label="Document the reason for this decision *"><textarea className={inputCls} rows={3} minLength={decision.type === "REFUND" ? 20 : 8} required value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} /></Field>
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg p-2">{error}</p>}
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setDecision(null)}>Back</Btn><Btn type="submit" disabled={busy}><ShieldCheck className="w-4 h-4" /> {busy ? "Saving…" : `Confirm ${decision.action.toLowerCase()}`}</Btn></div>
      </form>}
    </Modal>
  </div>;
}
