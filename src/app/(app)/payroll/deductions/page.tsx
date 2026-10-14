"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, ClipboardCheck, HandCoins, History, ListFilter, Plus, ShieldCheck, Wallet } from "lucide-react";
import { Card, CardHeader, PageHeader, Field, inputCls, Btn, Modal, Loading, EmptyState, Badge } from "@/components/ui";
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

function FormField({ label, value, onChange, type = "text", required = false, min }: {
  label: string; value: string; onChange: (s: string) => void; type?: string; required?: boolean; min?: string;
}) {
  return <Field label={label}><input className={inputCls} type={type} value={value} min={min} required={required} onChange={(e) => onChange(e.target.value)} /></Field>;
}

/**
 * One ordinary deduction entry on the "Add another deduction" review list:
 * worker, category, amount, payroll month and once/monthly — nothing more is
 * mandatory. Optional evidence only travels when the author typed it, and the
 * statutory / attendance / incident blocks appear only for their own category.
 */
type Entry = {
  key: string;
  worker: PickedWorker;
  categoryCode: string;
  amount: string;
  rate: string;
  method: string;
  basis: string;
  frequencyMonths: "0" | "1";
  startMonth: string;
  lateReason: string;
  description: string;
  reference: string;
  evidenceRef: string;
  authorityRef: string;
  consentRef: string;
  consentOn: string;
  endMonth: string;
  attendanceId: string;
  workingDays: string;
  incidentKey: string;
  incidentQuantity: string;
  incidentLossAmount: string;
  incidentFindings: string;
  incidentLossBasis: string;
  annualGross: string;
  annualPension: string;
  annualNhf: string;
  annualNhis: string;
  annualRentPaid: string;
  annualOtherRelief: string;
  otherReliefBasis: string;
  minimumWageExempt: boolean;
};

function blankEntry(worker: PickedWorker, startMonth = monthNow()): Entry {
  return {
    key: `e${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    worker, categoryCode: "HOUSE_RENT", amount: "", rate: "", method: "FIXED", basis: "AFTER_SUPPORT", frequencyMonths: "0",
    startMonth, lateReason: "", description: "", reference: "", evidenceRef: "", authorityRef: "",
    consentRef: "", consentOn: today(), endMonth: "", attendanceId: "", workingDays: "",
    incidentKey: "", incidentQuantity: "", incidentLossAmount: "", incidentFindings: "", incidentLossBasis: "",
    annualGross: "", annualPension: "0", annualNhf: "0", annualNhis: "0", annualRentPaid: "0",
    annualOtherRelief: "0", otherReliefBasis: "", minimumWageExempt: false,
  };
}

/** Wire one entry into the API body. Empty optional fields are simply omitted,
 * and the server derives the description and reference when they are missing. */
function entryBody(e: Entry): any {
  const body: any = {
    workerId: e.worker.id,
    categoryCode: e.categoryCode,
    startMonth: e.startMonth,
    frequencyMonths: e.frequencyMonths === "1" ? 1 : 0,
    method: e.method,
    basis: e.basis,
    amount: e.method === "PERCENT" ? undefined : Number(e.amount),
  };
  if (e.method === "PERCENT") body.rateBps = Math.round(Number(e.rate) * 100);
  if (e.frequencyMonths === "1" && e.endMonth) body.endMonth = e.endMonth;
  if (e.description.trim()) body.description = e.description.trim();
  if (e.reference.trim()) body.reference = e.reference.trim();
  if (e.evidenceRef.trim()) body.evidenceRef = e.evidenceRef.trim();
  if (e.authorityRef.trim()) body.authorityRef = e.authorityRef.trim();
  if (e.consentRef.trim()) { body.consentRef = e.consentRef.trim(); body.consentOn = e.consentOn; }
  if (e.startMonth < monthNow()) body.lateReason = e.lateReason.trim();
  if (e.categoryCode === "STATUTORY_TAX") {
    body.method = "PAYE_2026";
    body.frequencyMonths = 1;
    body.endMonth = "2026-12";
    body.amount = undefined;
    body.annualGross = Number(e.annualGross);
    body.annualPension = Number(e.annualPension || 0);
    body.annualNhf = Number(e.annualNhf || 0);
    body.annualNhis = Number(e.annualNhis || 0);
    body.annualRentPaid = Number(e.annualRentPaid || 0);
    body.annualOtherRelief = Number(e.annualOtherRelief || 0);
    body.otherReliefBasis = e.otherReliefBasis.trim() || undefined;
    body.minimumWageExempt = e.minimumWageExempt;
    body.evidenceRef = e.evidenceRef.trim();
    body.lateReason = e.startMonth < monthNow() ? e.lateReason.trim() : undefined;
    if (!body.evidenceRef) delete body.evidenceRef;
    delete body.rateBps;
  }
  if (e.categoryCode === "ABSENCE") {
    body.method = "ATTENDANCE";
    body.frequencyMonths = 0;
    body.amount = undefined;
    body.attendanceId = Number(e.attendanceId);
    body.workingDays = Number(e.workingDays);
    body.evidenceRef = e.evidenceRef.trim();
    delete body.rateBps;
  }
  if (e.categoryCode === "DAMAGE") {
    body.method = "FIXED";
    body.frequencyMonths = 0;
    body.amount = Number(e.amount);
    if (e.incidentKey.startsWith("INCIDENT:")) {
      body.incidentProductionId = Number(e.incidentKey.slice(9));
    } else {
      Object.assign(body, damageInspectionPayload(e.incidentKey));
      body.incidentQuantity = Number(e.incidentQuantity);
      body.incidentLossAmount = Number(e.incidentLossAmount);
      body.incidentFindings = e.incidentFindings.trim();
      body.incidentLossBasis = e.incidentLossBasis.trim();
      body.authorityRef = e.authorityRef.trim();
      body.evidenceRef = e.evidenceRef.trim();
    }
    delete body.rateBps;
    delete body.lateReason;
    if (e.startMonth < monthNow()) body.lateReason = e.lateReason.trim();
  }
  return body;
}

export default function PayrollDeductionsPage() {
  const [tab, setTab] = useState<Tab>("Records");
  const [month, setMonth] = useState(monthNow());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [catalogue, setCatalogue] = useState<any>({ builtins: [], custom: [] });
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
  const [auditType, setAuditType] = useState("");
  const [reversals, setReversals] = useState<any[]>([]);
  const [attendanceWorker, setAttendanceWorker] = useState<PickedWorker | null>(null);
  const [attendanceDays, setAttendanceDays] = useState<any[]>([]);
  const [attendanceForm, setAttendanceForm] = useState({ day: today(), status: "PRESENT", reason: "", evidenceRef: "" });
  const [editingDay, setEditingDay] = useState<number | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [decision, setDecision] = useState<{ type: "DEDUCTION" | "REVERSAL" | "REFUND" | "CATEGORY" | "COOP_WITHDRAWAL" | "COOP_ADJUSTMENT"; id: number; action: string; label: string } | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);

  // --- Simple deduction builder (worker + category + amount + month + once/monthly) ---
  const [entry, setEntry] = useState<Entry | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [showOptional, setShowOptional] = useState(false);
  const [reviewList, setReviewList] = useState(false);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [manualIncident, setManualIncident] = useState(false);
  const [manualSource, setManualSource] = useState<"STAGE" | "SUPPORT">("STAGE");

  // --- Internal Tax: several workers, one editable amount each ---
  const [taxGroup, setTaxGroup] = useState(false);
  const [taxWorkers, setTaxWorkers] = useState<PickedWorker[]>([]);
  const [taxAmounts, setTaxAmounts] = useState<Record<number, string>>({});
  const [taxStart, setTaxStart] = useState(monthNow());
  const [taxRecurring, setTaxRecurring] = useState<"0" | "1">("0");

  // --- Cooperative fund: members, withdrawals, adjustments ---
  const [members, setMembers] = useState<any>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberDeferred, setMemberDeferred] = useState("");
  const [withdrawals, setWithdrawals] = useState<any>({ rows: [], total: 0 });
  const [adjustments, setAdjustments] = useState<any>({ rows: [], total: 0 });
  const [wdModal, setWdModal] = useState<null | { mode: "request" | "pay"; row?: any }>(null);
  const [wdForm, setWdForm] = useState({ workerId: "", amount: "", reason: "", paidOn: today(), paymentMethod: "Bank Transfer", paymentReference: "" });
  const [adjModal, setAdjModal] = useState(false);
  const [adjForm, setAdjForm] = useState({ workerId: "", amount: "", reason: "", reference: "" });
  const [reportExtras, setReportExtras] = useState<any>(null);

  const categoryOptions = useMemo(() => [
    ...(catalogue.builtins || []).map((item: any) => ({ value: item.code, label: item.name })),
    ...(catalogue.custom || []).filter((c: any) => c.active).map((c: any) => ({ value: `CUSTOM:${c.id}`, label: c.name })),
  ], [catalogue]);
  const categoryNameOf = (code: string) => categoryOptions.find((c: any) => c.value === code)?.label ?? code;
  const exceptional = entry ? ["STATUTORY_TAX", "ABSENCE", "DAMAGE"].includes(entry.categoryCode) : false;

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
      .then((data: any) => setReview(data.history?.find((entryItem: any) => entryItem.month === month) ?? null)).catch(showError);
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
  const loadMembers = useCallback(() => {
    const q = new URLSearchParams({ view: "members", limit: "50" });
    if (memberDeferred) q.set("search", memberDeferred);
    return api(`/api/payroll-deductions/cooperative?${q}`).then(setMembers).catch(showError);
  }, [memberDeferred]);
  const loadWithdrawals = useCallback(() =>
    api("/api/payroll-deductions/cooperative/withdrawals?limit=50").then(setWithdrawals).catch(showError), []);
  const loadAdjustments = useCallback(() =>
    api("/api/payroll-deductions/cooperative/adjustments?limit=50").then(setAdjustments).catch(showError), []);

  useEffect(() => {
    loadCatalog();
    api<any>("/api/payroll-deductions/workers?view=departments").then((d) => setDepartments(d.departments.filter(Boolean))).catch(showError);
  }, [loadCatalog]);
  useEffect(() => { if (tab === "Records") loadRecords(); }, [tab, loadRecords]);
  useEffect(() => { if (tab === "Payroll review") loadReview(); if (tab === "Cooperative") loadLedger(); }, [tab, loadReview, loadLedger]);
  useEffect(() => { if (tab === "Attendance") loadAttendance(); }, [tab, loadAttendance]);
  useEffect(() => { if (tab === "Reports") loadReport(); }, [tab, loadReport]);
  useEffect(() => {
    if (tab !== "Reports") return;
    let live = true;
    Promise.all([
      api("/api/payroll-deductions/cooperative?view=members&limit=1"),
      api("/api/production-incidents?limit=100"),
    ]).then(([memberTotals, incidentList]) => { if (live) setReportExtras({ coop: memberTotals, incidents: incidentList }); })
      .catch(showError);
    return () => { live = false; };
  }, [tab, month]);
  useEffect(() => {
    if (tab !== "Audit") return;
    const q = new URLSearchParams({ view: "audit", limit: "50" });
    if (auditType) q.set("entityType", auditType);
    api<any>(`/api/payroll-deductions?${q}`).then((d) => setAudit(d.rows)).catch(showError);
  }, [tab, auditType, message]);
  useEffect(() => { if (tab === "Payroll review") api<any>("/api/payroll-deductions/reversals?limit=50").then((d) => setReversals(d.rows)).catch(showError); }, [tab, message]);
  useEffect(() => {
    if (tab !== "Cooperative") return;
    let live = true;
    Promise.all([loadMembers(), loadWithdrawals(), loadAdjustments()]);
    return () => { live = false; };
  }, [tab, loadMembers, loadWithdrawals, loadAdjustments, message]);
  useEffect(() => {
    const t = setTimeout(() => setMemberDeferred(memberSearch), 250);
    return () => clearTimeout(t);
  }, [memberSearch]);
  // Scalars extracted so the effects below depend on stable values instead of
  // the whole entry object (which would re-trigger on every keystroke).
  const entryCategory = entry?.categoryCode;
  const entryWorkerId = entry?.worker?.id;
  const entryIncidentKey = entry?.incidentKey ?? "";
  const entryStartMonth = entry?.startMonth;
  useEffect(() => {
    if (entryCategory !== "DAMAGE" || entryIncidentKey.startsWith("INCIDENT:") || !entryWorkerId) return;
    let live = true;
    Promise.all([
      api<any>(`/api/payroll-deductions/incidents?workerId=${entryWorkerId}`),
      api<any>(`/api/production-incidents?workerId=${entryWorkerId}&status=APPROVED_FOR_DEDUCTION&limit=20`),
    ]).then(([inspectionRows, incidentRows]) => {
      if (!live) return;
      setIncidents([
        ...(incidentRows.rows ?? []).map((row: any) => ({
          source: "INCIDENT", id: row.incident.id, orderNumber: `Incident #${row.incident.id}`,
          stage: row.incident.incidentType.replaceAll("_", " "), operation: null,
          quantityRejected: row.incident.approvedQuantity ?? row.incident.incompleteQuantity ?? 0,
        })),
        ...inspectionRows.rows,
      ]);
    }).catch(showError);
    return () => { live = false; };
  }, [entryCategory, entryWorkerId, entryIncidentKey]);
  useEffect(() => {
    if (entryCategory !== "ABSENCE" || !entryWorkerId || !entryStartMonth) return;
    let live = true;
    api<any>(`/api/payroll-deductions/attendance?month=${entryStartMonth}&workerId=${entryWorkerId}`)
      .then((d) => { if (live) setAttendanceDays(d.rows); }).catch(showError);
    return () => { live = false; };
  }, [entryCategory, entryWorkerId, entryStartMonth]);

  function go(next: Tab) { setTab(next); setError(""); setMessage(""); }

  function chooseEntryWorker(person: PickedWorker) {
    setEntry((old) => {
      const base = old ?? blankEntry(person);
      return { ...base, worker: person, attendanceId: "", incidentKey: "" };
    });
    setIncidents([]);
    setManualIncident(false);
  }
  function setEntryField(key: keyof Entry, value: string | boolean) {
    setEntry((old) => (old ? { ...old, [key]: value } as Entry : old));
  }
  function onCategoryChange(code: string) {
    setEntry((old) => old ? {
      ...old, categoryCode: code,
      method: code === "STATUTORY_TAX" ? "PAYE_2026" : code === "ABSENCE" ? "ATTENDANCE" : "FIXED",
      frequencyMonths: code === "STATUTORY_TAX" ? "1" : "0",
      endMonth: code === "STATUTORY_TAX" ? "2026-12" : "",
      attendanceId: "", incidentKey: "",
    } as Entry : old);
    setManualIncident(false);
    setTaxGroup(false);
    setShowOptional(false);
  }

  /** "Add another deduction" — the current entry joins the review list with its
   * own worker, category, amount, month and frequency; duplicates are refused
   * by the server on recalculate, review, posting and now creation. */
  function addEntry() {
    if (!entry || !entry.worker.id) return showError(new Error("Choose the worker for this deduction."));
    if (entry.method !== "PERCENT" && !(Number(entry.amount) > 0)) return showError(new Error("Enter the deduction amount."));
    if (entry.method === "PERCENT" && !(Number(entry.rate) > 0)) return showError(new Error("Enter the percentage."));
    if (entry.startMonth < monthNow() && entry.lateReason.trim().length < 10)
      return showError(new Error("Explain (10+ characters) why this prior unpaid month is being entered now."));
    setEntries((old) => [...old, entry]);
    setEntry(blankEntry(entry.worker, entry.startMonth));
    setShowOptional(false);
    setError("");
    setMessage("Deduction queued below. Add another, or review and save them together.");
    setReviewList(true);
  }

  async function saveEntries() {
    setBusy(true); setError("");
    try {
      const queue = entry && entry.worker.id && (Number(entry.amount) > 0 || Number(entry.rate) > 0) && !entries.includes(entry)
        ? [...entries, entry] : entries;
      if (!queue.length) throw new Error("Nothing to save yet: fill in worker, category and amount, then press Save.");
      const items = queue.map(entryBody);
      const result = await api<any>("/api/payroll-deductions", { method: "POST", body: { items } });
      setMessage(`${result.count} deduction proposal${result.count === 1 ? "" : "s"} saved. Review and approve them in Records before any pay changes.`);
      setEntries([]); setEntry(null); setReviewList(false); setTab("Records"); loadRecords();
    } catch (err) { showError(err); } finally { setBusy(false); }
  }

  async function saveTaxGroup() {
    setBusy(true); setError("");
    try {
      if (taxWorkers.length < 2) throw new Error("Pick at least two workers for the group Tax entry (use the single form for one worker).");
      const workerAmounts = taxWorkers.map((p) => ({ workerId: p.id, amount: Number(taxAmounts[p.id] ?? "") }));
      if (workerAmounts.some((a) => !(a.amount > 0))) throw new Error("Enter a Tax amount for every selected worker.");
      const body: any = {
        categoryCode: "INTERNAL_TAX",
        selection: { type: "IDS", workerIds: taxWorkers.map((p) => p.id) },
        workerAmounts,
        amount: workerAmounts[0].amount,
        method: "FIXED",
        startMonth: taxStart,
        frequencyMonths: taxRecurring === "1" ? 1 : 0,
      };
      if (taxStart < monthNow()) body.lateReason = "Internal Tax arrangement recorded for the still-open previous payroll month";
      const result = await api<any>("/api/payroll-deductions", { method: "POST", body });
      setMessage(`${result.count} Tax deduction proposal${result.count === 1 ? "" : "s"} created — shown as "Tax", never as statutory PAYE. Approve each in Records.`);
      setTaxGroup(false); setTaxWorkers([]); setTaxAmounts({}); setTab("Records"); loadRecords();
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
      } else if (decision.type === "COOP_WITHDRAWAL") {
        await api("/api/payroll-deductions/cooperative/withdrawals", { method: "PUT", body: {
          id: decision.id, action: decision.action, reason: decisionReason,
        } });
      } else if (decision.type === "COOP_ADJUSTMENT") {
        await api("/api/payroll-deductions/cooperative/adjustments", { method: "PUT", body: {
          id: decision.id, action: decision.action, reason: decisionReason,
        } });
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
      setMessage("Custom category created. It behaves like the other ordinary categories.");
      setNewCategory(""); loadCatalog();
    } catch (err) { showError(err); } finally { setBusy(false); }
  }

  async function submitWithdrawal(e: React.FormEvent) {
    e.preventDefault(); if (!wdModal) return;
    setBusy(true); setError("");
    try {
      if (wdModal.mode === "request") {
        await api("/api/payroll-deductions/cooperative/withdrawals", { method: "POST", body: {
          workerId: Number(wdForm.workerId), amount: Number(wdForm.amount), reason: wdForm.reason.trim(),
        } });
        setMessage("Withdrawal requested. No money moves until an independent Owner records the completed payment.");
      } else {
        await api("/api/payroll-deductions/cooperative/withdrawals", { method: "PUT", body: {
          id: wdModal.row.withdrawal.id, action: "RECORD_PAYMENT",
          paymentMethod: wdForm.paymentMethod, paidOn: wdForm.paidOn,
          ...(wdForm.paymentReference.trim() ? { paymentReference: wdForm.paymentReference.trim() } : {}),
        } });
        setMessage("Payment recorded; the fund balance is reduced exactly once.");
      }
      setWdModal(null);
      setWdForm({ workerId: "", amount: "", reason: "", paidOn: today(), paymentMethod: "Bank Transfer", paymentReference: "" });
    } catch (err) { showError(err); } finally { setBusy(false); }
  }
  async function submitAdjustment(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/payroll-deductions/cooperative/adjustments", { method: "POST", body: {
        workerId: Number(adjForm.workerId), amount: Number(adjForm.amount), reason: adjForm.reason.trim(),
        ...(adjForm.reference.trim() ? { reference: adjForm.reference.trim() } : {}),
      } });
      setMessage("Adjustment proposed. A different Owner must approve it before it changes the fund.");
      setAdjModal(false);
      setAdjForm({ workerId: "", amount: "", reason: "", reference: "" });
    } catch (err) { showError(err); } finally { setBusy(false); }
  }

  const queuedTotal = entries.reduce((sum, item) => sum + (item.method === "PERCENT" ? 0 : Number(item.amount) || 0), 0);
  const queuedByWorker = useMemo(() => {
    const map = new Map<number, { name: string; total: number; count: number }>();
    for (const item of entries) {
      const row = map.get(item.worker.id) ?? { name: item.worker.name, total: 0, count: 0 };
      row.total += Number(item.amount) || 0; row.count += 1;
      map.set(item.worker.id, row);
    }
    return [...map.values()];
  }, [entries]);

  return <div>
    <PageHeader title="Payroll Deductions" subtitle="Propose a deduction (worker, category, amount, month, once or monthly) → review → approve → post the completed month. Nothing is charged automatically, and posted statements are never rewritten."
      action={<Btn href="/payroll" variant="secondary"><HandCoins className="w-4 h-4" /> Worker Payments</Btn>} />
    <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Payroll deductions sections">
      {tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} onClick={() => go(name)}
        className={`rounded-lg px-3 py-2 text-xs sm:text-sm font-semibold border min-h-11 ${tab === name ? "border-matesther-800 bg-matesther-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-matesther-50"}`}>{name}</button>)}
    </div>
    {error && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
    {message && <div role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{message}</div>}

    {tab === "Records" && <Card>
      <CardHeader title="Worker deduction records" subtitle="Every proposal shows its worker, category, amount, payroll month and frequency. Approving one changes nothing already posted."
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
            {["PENDING", "APPROVED"].includes(d.status) && <Btn variant="ghost" onClick={() => openDecision("DEDUCTION", d.id, "CANCEL", `${workerName} · ${d.categoryName}`)}>Stop future months</Btn>}
            <Btn variant="ghost" onClick={() => { setReviewWorker({ id: d.workerId, name: workerName, department: null, specialty: "" }); setMonth(d.startMonth); go("Payroll review"); }}>Preview pay</Btn>
          </div>
        </div>)}
      </div> : <EmptyState title="No proposals match" hint="Create one in New deduction or change the filters." />}
      <div className="flex justify-between px-4 py-3 border-t border-slate-100">
        <Btn variant="secondary" disabled={recordPage === 0} onClick={() => setRecordPage(recordPage - 1)}>Previous</Btn>
        <Btn variant="secondary" disabled={(recordPage + 1) * 25 >= records.total} onClick={() => setRecordPage(recordPage + 1)}>Next</Btn>
      </div>
    </Card>}

    {tab === "New deduction" && <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <h2 className="text-lg font-bold mb-1">New deduction</h2>
        <p className="text-sm text-slate-600 mb-4">Only worker, category, amount, payroll month and once/monthly are required. Statutory PAYE, unpaid-leave and production-incident charges ask for their own evidence when — and only when — those categories are selected.</p>
        {!entry ? <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-600">Pick the worker this deduction is for.</p>
          <WorkerPicker onChoose={chooseEntryWorker} selected={[]} />
        </div> : <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm">
            Worker: <strong>{entry.worker.name}</strong>
            <button type="button" className="ml-3 underline text-xs text-matesther-800" onClick={() => { setEntry(null); setTaxGroup(false); }}>change</button>
          </div>
          <Field label="Category *"><select className={inputCls} value={entry.categoryCode} onChange={(e) => onCategoryChange(e.target.value)}>
            {categoryOptions.map((item: any) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select></Field>
          {["INTERNAL_TAX"].includes(entry.categoryCode) && <Field label="Calculation"><select className={inputCls} value={entry.method} onChange={(e) => setEntryField("method", e.target.value)}>
            <option value="FIXED">Fixed amount</option><option value="VARIABLE">Variable, one-time (independent review)</option>
          </select></Field>}
          {!exceptional && entry.categoryCode !== "INTERNAL_TAX" && <Field label="Calculation (optional)"><select className={inputCls} value={entry.method} onChange={(e) => setEntryField("method", e.target.value)}>
            <option value="FIXED">Fixed amount</option><option value="PERCENT">Percentage of pay or salary</option><option value="VARIABLE">Variable, one-time (independent review)</option>
          </select></Field>}
          {entry.method === "PERCENT" ? <>
            <FormField label="Percent (e.g. 2.5) *" type="number" min="0.01" value={entry.rate} onChange={(v) => setEntryField("rate", v)} required />
            <Field label="Percent of"><select className={inputCls} value={entry.basis} onChange={(e) => setEntryField("basis", e.target.value)}>
              <option value="AFTER_SUPPORT">Approved earnings after helper share</option><option value="SALARY">Monthly salary only</option>
            </select></Field>
          </> : entry.categoryCode !== "STATUTORY_TAX" && entry.categoryCode !== "ABSENCE" &&
            <FormField label="Deduction amount (₦) *" type="number" min="1" value={entry.amount} onChange={(v) => setEntryField("amount", v)} required />}
          <FormField label="Payroll month *" type="month" value={entry.startMonth} onChange={(v) => setEntryField("startMonth", v)} required />
          <Field label="Frequency"><select className={inputCls} value={entry.frequencyMonths} disabled={["STATUTORY_TAX", "ABSENCE", "DAMAGE"].includes(entry.categoryCode)}
            onChange={(e) => setEntryField("frequencyMonths", e.target.value as "0" | "1")}>
            <option value="0">One time</option><option value="1">Every month (until stopped)</option>
          </select></Field>
          {entry.startMonth < monthNow() && <FormField label="Reason for this prior, unpaid month *" value={entry.lateReason} onChange={(v) => setEntryField("lateReason", v)} required />}

          {entry.categoryCode === "STATUTORY_TAX" && <>
            <p className="sm:col-span-2 rounded-lg bg-blue-50 p-3 text-xs text-blue-900">Statutory PAYE under the 2026 law, kept fully separate from the company&apos;s own Tax deduction. Verify the worker&apos;s annual taxable income, pension/NHF/NHIS and actual paid rent (20% relief capped at ₦500,000). A different Owner must approve the assessment.</p>
            <FormField label="Assessed annual gross (₦) *" type="number" value={entry.annualGross} onChange={(v) => setEntryField("annualGross", v)} required />
            {(["annualPension", "annualNhf", "annualNhis", "annualRentPaid", "annualOtherRelief"] as const).map((key) =>
              <FormField key={key} label={`${key.replace("annual", "Verified annual ")} (₦)`} type="number" min="0" value={entry[key]} onChange={(v) => setEntryField(key, v)} />)}
            {Number(entry.annualOtherRelief) > 0 && <FormField label="Statutory basis for other relief *" value={entry.otherReliefBasis} onChange={(v) => setEntryField("otherReliefBasis", v)} required />}
            <FormField label="Assessment / policy evidence reference *" value={entry.evidenceRef} onChange={(v) => setEntryField("evidenceRef", v)} required />
            <label className="sm:col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={entry.minimumWageExempt} onChange={(e) => setEntryField("minimumWageExempt", e.target.checked)} /> Evidenced employee earning statutory minimum wage (≤ ₦70,000/month)</label>
          </>}

          {entry.categoryCode === "DAMAGE" && <>
            <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-950">A production incident charge follows a reviewed incident (or a rejected inspection for older cases). Recording an incident never deducts anything by itself, and one incident supports at most one deduction.</p>
            <Field label="Reviewed incident or rejected inspection *"><select className={inputCls}
              value={manualIncident ? "MANUAL" : entry.incidentKey}
              onChange={(e) => {
                const value = e.target.value;
                setManualIncident(value === "MANUAL");
                setEntryField("incidentKey", value === "MANUAL" ? "" : value);
              }} required>
              <option value="">Choose…</option>
              {incidents.map((i) => <option key={`${i.source}:${i.id}`} value={`${i.source}:${i.id}`}>
                {i.source === "INCIDENT" ? "Reviewed incident" : i.source === "SUPPORT" ? "Support inspection" : "Stage inspection"} #{i.id} · {i.orderNumber} · {i.stage}
                {i.operation ? ` · ${i.operation}` : ""} · {i.quantityRejected} {i.source === "INCIDENT" ? "reviewed" : "rejected"}
              </option>)}
              <option value="MANUAL">Older inspection: enter its source and ID…</option>
            </select></Field>
            {manualIncident && <>
              <Field label="Older inspection source *"><select className={inputCls} value={manualSource} onChange={(e) => {
                setManualSource(e.target.value as "STAGE" | "SUPPORT"); setEntryField("incidentKey", "");
              }}><option value="STAGE">Stage inspection</option><option value="SUPPORT">Support-work inspection</option></select></Field>
              <FormField label="Older rejected inspection ID *" type="number" min="1"
                value={entry.incidentKey.split(":")[1] || ""}
                onChange={(v) => setEntryField("incidentKey", v ? `${manualSource}:${v}` : "")} required />
            </>}
            {!entry.incidentKey.startsWith("INCIDENT:") && <>
              <FormField label="Responsible rejected quantity *" type="number" value={entry.incidentQuantity} onChange={(v) => setEntryField("incidentQuantity", v)} required />
              <FormField label="Proven NET loss after withheld earnings (₦) *" type="number" value={entry.incidentLossAmount} onChange={(v) => setEntryField("incidentLossAmount", v)} required />
              <FormField label="Finding of wilful misconduct / neglect *" value={entry.incidentFindings} onChange={(v) => setEntryField("incidentFindings", v)} required />
              <FormField label="How was remaining loss calculated? *" value={entry.incidentLossBasis} onChange={(v) => setEntryField("incidentLossBasis", v)} required />
              <FormField label="Prior written labour-officer approval reference *" value={entry.authorityRef} onChange={(v) => setEntryField("authorityRef", v)} required />
              <FormField label="Case evidence reference *" value={entry.evidenceRef} onChange={(v) => setEntryField("evidenceRef", v)} required />
            </>}
            {entry.incidentKey.startsWith("INCIDENT:") && <p className="sm:col-span-2 text-xs text-slate-500">The reviewed incident supplies the quantities, findings and loss calculation. Enter only the agreed charge amount (it cannot exceed the reviewed amount).</p>}
          </>}

          {entry.categoryCode === "ABSENCE" && <>
            <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-950">Only an explicitly recorded unpaid leave or unauthorized absence for a monthly-paid worker can affect salary. Missing attendance rows never produce charges.</p>
            <Field label="Recorded unpaid day *"><select className={inputCls} value={entry.attendanceId} onChange={(e) => setEntryField("attendanceId", e.target.value)} required>
              <option value="">Choose an unpaid day from Attendance…</option>{attendanceDays.filter((a) => ["UNPAID_LEAVE", "UNAUTHORIZED_ABSENCE"].includes(a.status)).map((a) =>
                <option key={a.id} value={a.id}>{a.day} · {a.status.replaceAll("_", " ")} · {a.reason}</option>)}
            </select></Field>
            <FormField label="Documented payable working days this month (1–31) *" type="number" min="1" value={entry.workingDays} onChange={(v) => setEntryField("workingDays", v)} required />
            <FormField label="Working-day policy / leave evidence reference *" value={entry.evidenceRef} onChange={(v) => setEntryField("evidenceRef", v)} required />
          </>}

          {entry.categoryCode === "INTERNAL_TAX" && !taxGroup && <div className="sm:col-span-2 flex flex-wrap items-center gap-3 rounded-lg border border-matesther-200 bg-matesther-50 p-3">
            <p className="text-xs text-matesther-900 flex-1 min-w-44">This is the company&apos;s own Tax withholding — never statutory PAYE and never a government remittance. For several workers with one amount each, use the group entry.</p>
            <Btn variant="secondary" onClick={() => { setTaxGroup(true); setTaxWorkers([entry.worker]); setTaxAmounts({ [entry.worker.id]: entry.amount || "" }); setTaxStart(entry.startMonth); setTaxRecurring(entry.frequencyMonths); }}><ListFilter className="w-4 h-4" /> Tax for several workers</Btn>
          </div>}

          <details className="sm:col-span-2 rounded-lg border border-slate-200 p-3" open={showOptional} onToggle={(e) => setShowOptional((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">Optional details (description, reference, consent, end month)</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <FormField label="Description (auto-written when blank)" value={entry.description} onChange={(v) => setEntryField("description", v)} />
              <FormField label="Unique agreement / case reference (auto-generated when blank)" value={entry.reference} onChange={(v) => setEntryField("reference", v)} />
              <FormField label="Worker consent / agreement reference (optional)" value={entry.consentRef} onChange={(v) => setEntryField("consentRef", v)} />
              <FormField label="Worker consent date" type="date" value={entry.consentOn} onChange={(v) => setEntryField("consentOn", v)} />
              <FormField label="Lawful basis / scheme authorisation reference (optional)" value={entry.authorityRef} onChange={(v) => setEntryField("authorityRef", v)} />
              <FormField label="Supporting evidence reference (optional)" value={entry.evidenceRef} onChange={(v) => setEntryField("evidenceRef", v)} />
              {entry.frequencyMonths === "1" && <FormField label="End month (blank = until stopped)" type="month" value={entry.endMonth} onChange={(v) => setEntryField("endMonth", v)} />}
            </div>
          </details>

          <div className="sm:col-span-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            <p className="mr-auto text-xs text-slate-500">Each deduction is proposed, reviewed and approved on its own. Recurring ones apply every month until you stop them.</p>
            <Btn variant="secondary" onClick={addEntry}><Plus className="w-4 h-4" /> Add Another Deduction</Btn>
            <Btn onClick={() => {
              const filled = entry.worker.id && ((entry.method === "PERCENT" && Number(entry.rate) > 0) || (entry.method !== "PERCENT" && Number(entry.amount) > 0));
              if (filled) addEntry(); else setReviewList(true);
            }}><ShieldCheck className="w-4 h-4" /> Review &amp; Save</Btn>
          </div>
        </div>}
      </Card>

      {taxGroup && <Card className="p-4 sm:p-5">
        <h2 className="font-bold mb-1">Tax for several workers</h2>
        <p className="text-sm text-slate-600 mb-3">One internal Tax arrangement per worker, each with its own editable amount. This never reports as statutory PAYE.</p>
        <WorkerPicker onChoose={(person) => {
          setTaxWorkers((old) => old.some((p) => p.id === person.id) ? old : [...old, person]);
          setTaxAmounts((old) => ({ ...old, [person.id]: old[person.id] ?? "" }));
        }} selected={taxWorkers.map((p) => p.id)} />
        <div className="mt-3 space-y-2">
          {taxWorkers.map((person) => <div key={person.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-2">
            <span className="flex-1 min-w-40 text-sm font-semibold">{person.name}</span>
            <input aria-label={`Tax amount for ${person.name}`} className={`${inputCls} w-36`} type="number" min="1" placeholder="Amount ₦"
              value={taxAmounts[person.id] ?? ""} onChange={(e) => setTaxAmounts((old) => ({ ...old, [person.id]: e.target.value }))} />
            <button type="button" className="text-xs underline text-red-700" onClick={() => {
              setTaxWorkers((old) => old.filter((p) => p.id !== person.id));
            }}>remove</button>
          </div>)}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <FormField label="Payroll month *" type="month" value={taxStart} onChange={setTaxStart} required />
          <Field label="Frequency"><select className={inputCls} value={taxRecurring} onChange={(e) => setTaxRecurring(e.target.value as "0" | "1")}>
            <option value="0">One time</option><option value="1">Every month (until stopped)</option>
          </select></Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Btn onClick={saveTaxGroup} disabled={busy || taxWorkers.length < 2}><BadgeCheck className="w-4 h-4" /> {busy ? "Saving…" : `Create ${taxWorkers.length || ""} Tax proposals`}</Btn>
          <Btn variant="secondary" onClick={() => setTaxGroup(false)}>Back to single deduction</Btn>
        </div>
      </Card>}

      {reviewList && <Card className="p-4 sm:p-5">
        <h2 className="font-bold mb-1">Review before saving</h2>
        <p className="text-sm text-slate-600 mb-3">{entries.length} deduction entr{entries.length === 1 ? "y" : "ies"} queued — each with its own worker, category, amount, payroll month and frequency.</p>
        {entries.length ? <div className="divide-y divide-slate-100">
          {entries.map((item, index) => <div key={item.key} className="flex flex-wrap items-start gap-3 py-2 text-sm">
            <div className="flex-1 min-w-56">
              <p className="font-semibold">{index + 1}. {item.worker.name} · {categoryNameOf(item.categoryCode)}</p>
              <p className="text-xs text-slate-500">{item.method === "PERCENT" ? `${item.rate}% of pay` : naira(Number(item.amount) || 0)} · {item.startMonth} · {item.frequencyMonths === "1" ? "every month" : "one time"}
                {item.startMonth < monthNow() ? " · late entry with reason" : ""}</p>
            </div>
            <Btn variant="ghost" onClick={() => setEntries((old) => old.filter((e) => e.key !== item.key))}>Remove</Btn>
          </div>)}
        </div> : <p className="text-sm text-slate-500">The list is empty — use Add Another Deduction, or finish the form above and press Save.</p>}
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
          <p className="font-semibold">Totals</p>
          <p className="text-xs text-slate-600">{entries.length} deduction{entries.length === 1 ? "" : "s"} · {naira(queuedTotal)} per application</p>
          {queuedByWorker.map((row) => <p key={row.name} className="text-xs text-slate-600">{row.name}: {row.count} deduction{row.count === 1 ? "" : "s"} · {naira(row.total)}</p>)}
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Btn variant="secondary" onClick={() => setReviewList(false)}>Keep editing</Btn>
          <Btn disabled={busy || !entries.length} onClick={saveEntries}><ShieldCheck className="w-4 h-4" /> {busy ? "Saving…" : `Save ${entries.length || ""} deduction${entries.length === 1 ? "" : "s"}`}</Btn>
        </div>
      </Card>}
    </div>}

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
            <div>Deductions <strong className="block">{review.payrollDeductions < 0 ? `+${naira(-review.payrollDeductions)} refund` : `−${naira(review.payrollDeductions)}`}</strong><small>Statutory PAYE {naira(review.taxDeduction)} · company/other {naira(review.payrollDeductions - review.taxDeduction)}</small></div>
            <div>Net payable <strong className="block text-matesther-800 text-lg">{naira(review.due)}</strong><small>Paid {naira(review.paid)} · balance {naira(review.balance)} · {review.paymentStatus}</small></div>
          </div>
          {review.previewIssues?.map((issue: string, i: number) => <p key={i} className="rounded-lg bg-red-50 p-3 text-sm text-red-800">Cannot post: {issue}</p>)}
          {review.deductionItems?.length > 0 ? <div className="border-t border-slate-100 pt-3">
            <h3 className="text-sm font-semibold mb-2">Each deduction and credit (cooperative appears exactly once)</h3>
            {review.deductionItems.map((item: any) => <div key={`${item.deductionId ?? "refund"}-${item.id}`} className="flex justify-between gap-3 border-b border-slate-100 py-2 text-xs sm:text-sm">
              <div><strong>{item.categoryName}</strong> · {item.description}<p className="text-slate-500">{item.calculation}</p>
                {item.cooperativeCredit !== 0 && <p className="text-emerald-700">Cooperative balance {item.cooperativeCredit > 0 ? "credited" : "debited"} {naira(Math.abs(item.cooperativeCredit))}</p>}</div>
              <div className="text-right whitespace-nowrap"><strong>{item.amount < 0 ? `+${naira(-item.amount)} refund` : `−${naira(item.amount)}`}</strong>
                {review.finalized && item.amount > 0 && item.categoryCode !== "STATUTORY_TAX" &&
                  <button type="button" className="block text-amber-800 underline text-xs" onClick={() => openDecision("REFUND", item.id, "REFUND", item.categoryName)}>Request refund</button>}
              </div>
            </div>)}
          </div> : <p className="text-xs text-slate-500">No statutory or company deductions configured for this worker/month.</p>}
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

    {tab === "Cooperative" && <div className="space-y-4">
      <Card>
        <CardHeader title="Workers' cooperative savings fund" subtitle="Contributions come from posted payroll lines; withdrawals and authorised adjustments are the other two append-only sides. The balance is always computed — the company total is the sum of the member balances. These savings belong to the workers: never company income."
          action={<div className="flex flex-wrap gap-2">
            <Btn variant="secondary" onClick={() => { setWdModal({ mode: "request" }); setWdForm({ workerId: String(reviewWorker?.id ?? ""), amount: "", reason: "", paidOn: today(), paymentMethod: "Bank Transfer", paymentReference: "" }); }}><Wallet className="w-4 h-4" /> Request withdrawal</Btn>
            <Btn variant="secondary" onClick={() => { setAdjModal(true); setAdjForm({ workerId: String(reviewWorker?.id ?? ""), amount: "", reason: "", reference: "" }); }}><Plus className="w-4 h-4" /> Propose adjustment</Btn>
          </div>} />
        <div className="grid gap-3 px-4 pb-2 sm:grid-cols-4">
          <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Total held</p><strong className="text-lg">{naira(members?.totalHeld ?? 0)}</strong></div>
          <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Participants</p><strong className="text-lg">{members?.participating ?? 0}</strong></div>
          <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Contributed (posted)</p><strong className="text-lg">{naira(members?.totalContributions ?? 0)}</strong></div>
          <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Paid out</p><strong className="text-lg">{naira(members?.totalWithdrawals ?? 0)}</strong></div>
        </div>
        <div className="px-4 pb-3">
          <Field label="Search members by name or ID"><input className={inputCls} value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Search workers…" /></Field>
          {members?.rows?.length ? <div className="mt-2 divide-y divide-slate-100">
            {members.rows.map((row: any) => <div key={row.workerId} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <button type="button" className="flex-1 min-w-44 text-left" onClick={() => { setReviewWorker({ id: row.workerId, name: row.workerName, department: row.department, specialty: "" }); setLedger(null); }}>
                <strong>{row.workerName}</strong>
                <span className="block text-xs text-slate-500">contributed {naira(row.contributions)} · withdrawn {naira(row.withdrawals)}{row.adjustments ? ` · adjusted ${naira(row.adjustments)}` : ""}</span>
              </button>
              <strong className={row.balance < 0 ? "text-red-700" : "text-emerald-700"}>{naira(row.balance)}</strong>
            </div>)}
          </div> : <p className="mt-2 text-xs text-slate-500">No members match.</p>}
          {members && <p className="mt-2 text-xs text-slate-500">Company total {naira(members.totalHeld)} = sum of every member balance (adjustments {naira(members.totalAdjustments ?? 0)}).</p>}
        </div>
      </Card>

      {reviewWorker && <Card><CardHeader title={`${reviewWorker.name} · balance ${ledger ? naira(ledger.balance) : "…"}`} subtitle={ledger ? `${ledger.total} posted transaction${ledger.total === 1 ? "" : "s"} · contributions ${naira(ledger.contributions)} · withdrawals ${naira(ledger.withdrawals)}` : "Loading member ledger…"} />
        {ledger ? <div className="divide-y divide-slate-100">{ledger.transactions.map(({ line, kind, periodMonth, postedAt, balanceAfter }: any) => <div key={`${kind}-${line.id}`} className="p-3 text-sm flex justify-between gap-3">
          <div><strong>{periodMonth}</strong> · {line.description}<p className="text-xs text-slate-500">{line.calculation} · posted {fmtDate(postedAt)}</p></div>
          <div className="text-right whitespace-nowrap">
            <strong className={line.cooperativeCredit < 0 ? "text-red-700" : "text-emerald-700"}>{line.cooperativeCredit > 0 ? "+" : ""}{naira(line.cooperativeCredit)}</strong>
            <p className="text-xs text-slate-500">balance {naira(balanceAfter)}</p>
          </div>
        </div>)}{!ledger.transactions.length && <EmptyState title="No posted savings" hint="An approved proposal is not a credit until payroll is posted." />}</div> : <Loading />}
      </Card>}

      <Card><CardHeader title="Withdrawal requests" subtitle="Request → independent review → approve/reject → record the completed payment. A request or approval moves no money; only the recorded payment reduces the fund." />
        {withdrawals.rows?.length ? <div className="divide-y divide-slate-100">{withdrawals.rows.map(({ withdrawal: w, workerName }: any) => <div key={w.id} className="p-3 text-sm flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-56">
            <p className="font-semibold">{workerName} · {naira(w.amount)} <Badge status={w.status} /></p>
            <p className="text-xs text-slate-500">{w.reason} · requested by {w.requestedByName} · {fmtDate(w.requestedAt)}</p>
            {w.reviewedByName && <p className="text-xs text-slate-500">{w.reviewedByName}: {w.reviewReason} · {fmtDate(w.reviewedAt)}</p>}
            {w.status === "PAID" && <p className="text-xs text-emerald-700">Paid {fmtDate(w.paidOn)} · {w.paymentMethod}{w.paymentReference ? ` · ref ${w.paymentReference}` : ""} · recorded by {w.paidByName}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {w.status === "REQUESTED" && <>
              <Btn variant="secondary" onClick={() => openDecision("COOP_WITHDRAWAL", w.id, "APPROVE", `withdrawal #${w.id}`)}>Approve</Btn>
              <Btn variant="ghost" onClick={() => openDecision("COOP_WITHDRAWAL", w.id, "REJECT", `withdrawal #${w.id}`)}>Reject</Btn>
              <Btn variant="ghost" onClick={() => openDecision("COOP_WITHDRAWAL", w.id, "CANCEL", `withdrawal #${w.id}`)}>Cancel</Btn>
            </>}
            {w.status === "APPROVED" && <>
              <Btn variant="secondary" onClick={() => { setWdModal({ mode: "pay", row: { withdrawal: w } }); setWdForm((f) => ({ ...f, paymentReference: "" })); }}><Wallet className="w-4 h-4" /> Record payment</Btn>
              <Btn variant="ghost" onClick={() => openDecision("COOP_WITHDRAWAL", w.id, "CANCEL", `withdrawal #${w.id}`)}>Cancel</Btn>
            </>}
          </div>
        </div>)}</div> : <EmptyState title="No withdrawal requests" hint="Requested, approved, rejected, cancelled and paid draws all appear here." />}
      </Card>

      <Card><CardHeader title="Authorised adjustments" subtitle="Bank charges, clerical fixes, court orders: signed amounts proposed by one Owner and approved by another. Only an approved adjustment changes the fund." />
        {adjustments.rows?.length ? <div className="divide-y divide-slate-100">{adjustments.rows.map(({ adjustment: a, workerName }: any) => <div key={a.id} className="p-3 text-sm flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-56">
            <p className="font-semibold">{workerName} · <span className={a.amount < 0 ? "text-red-700" : "text-emerald-700"}>{a.amount > 0 ? "+" : ""}{naira(a.amount)}</span> <Badge status={a.status} /></p>
            <p className="text-xs text-slate-500">{a.reason}{a.reference ? ` · ref ${a.reference}` : ""} · proposed by {a.createdByName} · {fmtDate(a.createdAt)}</p>
            {a.reviewedByName && <p className="text-xs text-slate-500">{a.reviewedByName}: {a.reviewReason}</p>}
          </div>
          {a.status === "PENDING" && <div className="flex gap-2">
            <Btn variant="secondary" onClick={() => openDecision("COOP_ADJUSTMENT", a.id, "APPROVE", `adjustment #${a.id}`)}>Approve</Btn>
            <Btn variant="ghost" onClick={() => openDecision("COOP_ADJUSTMENT", a.id, "REJECT", `adjustment #${a.id}`)}>Reject</Btn>
            <Btn variant="ghost" onClick={() => openDecision("COOP_ADJUSTMENT", a.id, "CANCEL", `adjustment #${a.id}`)}>Cancel</Btn>
          </div>}
        </div>)}</div> : <EmptyState title="No adjustments" />}
      </Card>
    </div>}

    {tab === "Reports" && <div className="space-y-4">
      <Card><CardHeader title="Posted deduction report" subtitle="Only posted lines, including signed refunds; not pending or hypothetical deductions. Internal Tax and statutory PAYE are listed as separate categories." />
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
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader title="Cooperative fund summary" subtitle="Contributions, paid withdrawals and computed balances straight from the ledger." />
          <div className="p-4 grid gap-2 sm:grid-cols-2 text-sm">
            <p>Total held (sum of member balances): <strong>{naira(reportExtras?.coop?.totalHeld ?? 0)}</strong></p>
            <p>Participants: <strong>{reportExtras?.coop?.participating ?? 0}</strong></p>
            <p>Posted contributions: <strong>{naira(reportExtras?.coop?.totalContributions ?? 0)}</strong></p>
            <p>Paid withdrawals: <strong>{naira(reportExtras?.coop?.totalWithdrawals ?? 0)}</strong></p>
            <p>Approved adjustments: <strong>{naira(reportExtras?.coop?.totalAdjustments ?? 0)}</strong></p>
          </div>
        </Card>
        <Card><CardHeader title="Production incidents" subtitle="Recorded against work assignments; none of them deducts anything automatically." />
          <div className="p-4 text-sm space-y-1">
            {(["REPORTED", "CORRECTION_ONLY", "APPROVED_FOR_DEDUCTION", "REJECTED", "CANCELLED"] as const).map((status) => (
              <p key={status} className="flex justify-between border-b border-slate-100 py-1">
                <span>{status.replaceAll("_", " ")}</span>
                <strong>{reportExtras?.incidents?.rows?.filter((row: any) => row.incident.status === status).length ?? 0}</strong>
              </p>
            ))}
            <p className="text-xs text-slate-500 pt-1">Approved incidents become a deduction only through a separate, reviewed proposal.</p>
          </div>
        </Card>
      </div>
    </div>}

    {tab === "Categories" && <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader title="Built-in categories" subtitle="Statutory PAYE is separate from the company Tax deduction. These rules cannot be renamed into another type." />
        <div className="divide-y divide-slate-100">{catalogue.builtins?.map((c: any) => <div key={c.code} className="p-3 text-sm"><strong>{c.name}</strong><p className="text-xs text-slate-500">{c.code} · {c.kind}</p></div>)}</div>
      </Card><Card className="p-4"><h2 className="font-semibold mb-2">Company-defined categories</h2>
        <form onSubmit={addCategory} className="flex flex-wrap gap-2"><input className={`${inputCls} flex-1 min-w-44`} placeholder="e.g. Optional welfare fund" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} required /><Btn type="submit" disabled={busy}>Add category</Btn></form>
        <p className="text-xs text-slate-500 mt-2">Retiring a category prevents new proposals, not an existing signed agreement. Stop those individually in Records.</p>
        {catalogue.custom?.map((c: any) => <div key={c.id} className="border-b border-slate-100 py-3 flex justify-between gap-2 text-sm"><div><strong>{c.name}</strong> <span className="text-xs text-slate-500">{c.active ? "Active" : "Retired"}</span></div><div className="flex gap-2"><button className="text-xs underline" onClick={() => { setCategoryName(c.name); openDecision("CATEGORY", c.id, "RENAME", c.name); }}>Rename</button><button className="text-xs underline" onClick={() => openDecision("CATEGORY", c.id, c.active ? "RETIRE" : "ACTIVATE", c.name)}>{c.active ? "Retire" : "Activate"}</button></div></div>)}
      </Card>
    </div>}

    {tab === "Audit" && <Card><CardHeader title="Deduction decision history" subtitle="Append-only names, times, reasons, old and new values — covering deductions, cooperative withdrawals and adjustments, and production incidents." action={<History className="w-5 h-5 text-matesther-700" />} />
      <div className="grid gap-3 px-4 pt-2 sm:grid-cols-3">
        <Field label="Record type"><select className={inputCls} value={auditType} onChange={(e) => setAuditType(e.target.value)}>
          <option value="">All types</option>
          {["DEDUCTION", "REVERSAL", "STATEMENT", "ATTENDANCE", "CATEGORY", "COOP_WITHDRAWAL", "COOP_ADJUSTMENT", "PRODUCTION_INCIDENT"].map((t) => <option key={t}>{t}</option>)}
        </select></Field>
      </div>
      <div className="divide-y divide-slate-100 mt-2">{audit.map((entryItem: any) => <div key={entryItem.id} className="px-4 py-3 text-sm"><strong>{entryItem.action}</strong> · {entryItem.entityType} #{entryItem.entityId} · {entryItem.actorName}
        <p className="text-xs text-slate-600">{entryItem.reason}</p><p className="text-[11px] text-slate-400">{fmtDate(entryItem.createdAt)}</p>
      </div>)}{!audit.length && <EmptyState title="No decisions recorded" />}</div>
    </Card>}

    <Modal open={!!decision} title={decision ? `${decision.action}: ${decision.label}` : ""} onClose={() => setDecision(null)}>
      {decision && <form onSubmit={sendDecision} className="space-y-4">
        {decision.type === "REFUND" && <p className="text-xs text-amber-900 rounded bg-amber-50 p-3">This proposes a full refund in {monthNow()} for independent Owner approval. The original posted item remains unchanged. PAYE cannot be refunded through this route.</p>}
        {decision.type === "COOP_WITHDRAWAL" && <p className="text-xs text-amber-900 rounded bg-amber-50 p-3">Approval reserves the amount but moves no money. Only recording the completed cash/bank payment reduces the fund, and the requester cannot approve their own request.</p>}
        {decision.type === "COOP_ADJUSTMENT" && <p className="text-xs text-amber-900 rounded bg-amber-50 p-3">The proposer can never approve their own adjustment. Only an approved adjustment changes the computed balance.</p>}
        {decision.action === "APPROVE" && <p className="text-xs text-slate-600">Tax, damaged garments, unauthorized absences, variable cases, custom categories, refunds, cooperative withdrawals and adjustments require review by an Owner OTHER than the proposer where the rules say so. Backend permissions always enforce this.</p>}
        {decision.action === "RENAME" && <FormField label="New category name *" value={categoryName} onChange={setCategoryName} required />}
        <Field label="Document the reason for this decision *"><textarea className={inputCls} rows={3} minLength={decision.type === "REFUND" ? 20 : 8} required value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} /></Field>
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg p-2">{error}</p>}
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setDecision(null)}>Back</Btn><Btn type="submit" disabled={busy}><ShieldCheck className="w-4 h-4" /> {busy ? "Saving…" : `Confirm ${decision.action.toLowerCase()}`}</Btn></div>
      </form>}
    </Modal>

    <Modal open={!!wdModal} title={wdModal?.mode === "request" ? "Request cooperative withdrawal" : "Record completed payment"} onClose={() => setWdModal(null)}>
      {wdModal && <form onSubmit={submitWithdrawal} className="space-y-4">
        {wdModal.mode === "request" ? <>
          <p className="text-xs text-slate-600">The request is checked against the member&apos;s available balance (balance minus other outstanding requests). It moves no money until the payment is recorded.</p>
          <Field label="Member"><select className={inputCls} value={wdForm.workerId} onChange={(e) => setWdForm((f) => ({ ...f, workerId: e.target.value }))} required>
            <option value="">Choose a member…</option>
            {(members?.rows ?? []).map((row: any) => <option key={row.workerId} value={row.workerId}>{row.workerName} · balance {naira(row.balance)}</option>)}
          </select></Field>
          <FormField label="Amount (₦) *" type="number" min="1" value={wdForm.amount} onChange={(v) => setWdForm((f) => ({ ...f, amount: v }))} required />
          <FormField label="Reason for the withdrawal *" value={wdForm.reason} onChange={(v) => setWdForm((f) => ({ ...f, reason: v }))} required />
        </> : <>
          <p className="text-xs text-slate-600">Record the payment only once the cash or bank transfer is actually completed. This is the only step that reduces the fund.</p>
          <FormField label="Payment date *" type="date" value={wdForm.paidOn} onChange={(v) => setWdForm((f) => ({ ...f, paidOn: v }))} required />
          <Field label="Payment method *"><select className={inputCls} value={wdForm.paymentMethod} onChange={(e) => setWdForm((f) => ({ ...f, paymentMethod: e.target.value }))}>
            {["Cash", "Bank Transfer", "POS", "Other"].map((m) => <option key={m}>{m}</option>)}
          </select></Field>
          <FormField label="Payment reference (slip / transfer narration)" value={wdForm.paymentReference} onChange={(v) => setWdForm((f) => ({ ...f, paymentReference: v }))} />
        </>}
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg p-2">{error}</p>}
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setWdModal(null)}>Back</Btn><Btn type="submit" disabled={busy}><Wallet className="w-4 h-4" /> {busy ? "Saving…" : wdModal.mode === "request" ? "Send request" : "Record payment"}</Btn></div>
      </form>}
    </Modal>

    <Modal open={adjModal} title="Propose cooperative adjustment" onClose={() => setAdjModal(false)}>
      <form onSubmit={submitAdjustment} className="space-y-4">
        <p className="text-xs text-slate-600">Signed correction to a member&apos;s fund (bank charge, clerical fix, court order). A different Owner approves it before anything changes.</p>
        <Field label="Member"><select className={inputCls} value={adjForm.workerId} onChange={(e) => setAdjForm((f) => ({ ...f, workerId: e.target.value }))} required>
          <option value="">Choose a member…</option>
          {(members?.rows ?? []).map((row: any) => <option key={row.workerId} value={row.workerId}>{row.workerName} · balance {naira(row.balance)}</option>)}
        </select></Field>
        <FormField label="Signed amount (₦ — negative recovers from the fund) *" type="number" value={adjForm.amount} onChange={(v) => setAdjForm((f) => ({ ...f, amount: v }))} required />
        <FormField label="Reason for the adjustment *" value={adjForm.reason} onChange={(v) => setAdjForm((f) => ({ ...f, reason: v }))} required />
        <FormField label="Reference (optional)" value={adjForm.reference} onChange={(v) => setAdjForm((f) => ({ ...f, reference: v }))} />
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg p-2">{error}</p>}
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setAdjModal(false)}>Back</Btn><Btn type="submit" disabled={busy}><ShieldCheck className="w-4 h-4" /> {busy ? "Saving…" : "Propose adjustment"}</Btn></div>
      </form>
    </Modal>
  </div>;
}
