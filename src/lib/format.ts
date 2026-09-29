export function naira(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return "₦" + v.toLocaleString("en-NG");
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "-";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return String(d).slice(0, 10);
  return dt.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "-";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return "-";
  return (
    dt.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }) +
    " " +
    dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const due = new Date(dateStr);
  const now = new Date();
  due.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - now.getTime()) / 86400000);
}

/**
 * Official Matesther production workflow - 8 stages.
 * MONOGRAMMING / EMBROIDERY is a separate, fully tracked stage
 * because nearly every uniform carries a school/company logo.
 */
export const STAGES = [
  "CUTTING",
  "SEWING",
  "MONOGRAMMING",
  "BUTTONHOLE",
  "BUTTON_TACKING",
  "IRONING",
  "PACKING",
  "DELIVERY",
] as const;

export type Stage = (typeof STAGES)[number];

export function stageLabel(s: string): string {
  const map: Record<string, string> = {
    CUTTING: "Cutting",
    SEWING: "Sewing",
    MONOGRAMMING: "Monogramming / Embroidery",
    BUTTONHOLE: "Buttonhole",
    BUTTON_TACKING: "Button Tacking",
    IRONING: "Ironing",
    PACKING: "Packing",
    DELIVERY: "Delivery",
  };
  return map[s] ?? s;
}

export function statusColor(s: string): string {
  switch ((s || "").toUpperCase()) {
    case "COMPLETED":
    case "DELIVERED":
    case "ACTIVE":
    case "PAID":
    case "FIXED":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "IN_PROGRESS":
    case "IN PRODUCTION":
    case "PARTIAL":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "PENDING":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "SUBMITTED":
      return "bg-violet-100 text-violet-800 border-violet-200";
    case "ON_HOLD":
      return "bg-orange-100 text-orange-800 border-orange-200";
    case "CANCELLED":
    case "REJECTED":
    case "FAILED":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

export const EXPENSE_CATEGORIES = [
  "Materials",
  "Labour",
  "Transportation",
  "Electricity",
  "Packaging",
  "Repairs",
  "Other",
];

export const PAYMENT_METHODS = ["Cash", "Bank Transfer", "POS", "Other"];

export const WORKER_SPECIALTIES = [
  "Cutter",
  "Tailor",
  "Monogrammer",
  "Buttonhole",
  "Button Tacking",
  "Ironer",
  "Packer",
];

export const CUSTOMER_TYPES = ["SCHOOL", "COMPANY", "ORGANIZATION", "INDIVIDUAL"];

/** Operation statuses */
export const OP_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "SUBMITTED",
  "COMPLETED",
  "ON_HOLD",
  "CANCELLED",
] as const;
