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
/**
 * The production stages, in order.
 *
 * SINGLE SOURCE OF TRUTH. api/inspections, api/dashboard, api/reports and the
 * Settings page each used to keep their own private copy of this list, so the
 * four could drift apart. They now all import this one.
 *
 * Task 3 turns this into a per-garment ROUTE: not every product passes through
 * every stage, so a route will select and order a subset of these values. Until
 * then this array is the default route that every batch already follows.
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

/**
 * Every role a person may hold. The seven production roles above, plus the two
 * non-stage roles Matesther uses. One person may hold several at once.
 *
 * "Inspection Officer" and "Project Supervisor" are labels only. They grant no
 * API permission: inspecting is still gated server-side to OWNER and
 * PRODUCTION_MANAGER, and never on work the person submitted themselves.
 */
/** The seven roles that take part in the 8-stage production workflow. */
export const PRODUCTION_ROLES = [...WORKER_SPECIALTIES] as const;

/** Supporting garment work a tailor hands to a helper. */
export const SUPPORT_OPERATIONS = ["Weaving", "Taping", "Support Work", "Other Support"] as const;

/** The role held by someone who performs tailor support work. */
export const SUPPORT_ROLE = "Support Worker";

/**
 * Non-production staff positions.
 *
 * These are roles, not a second person system, so a security guard who also
 * sews is one record holding ["Security", "Tailor"] - never two people.
 */
export const STAFF_POSITIONS = [
  "Security",
  "Sales",
  "IT",
  "Administration",
  "Management",
  "Director",
  "Office Staff",
] as const;

export const WORKER_ROLES = [
  ...PRODUCTION_ROLES,
  SUPPORT_ROLE,
  "Inspection Officer",
  "Project Supervisor",
  ...STAFF_POSITIONS,
] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

/** The role a person must hold to be assigned each production stage. */
export const STAGE_ROLES: Record<string, string> = {
  CUTTING: "Cutter",
  SEWING: "Tailor",
  MONOGRAMMING: "Monogrammer",
  BUTTONHOLE: "Buttonhole",
  BUTTON_TACKING: "Button Tacking",
  IRONING: "Ironer",
  PACKING: "Packer",
  // DELIVERY was missing, so the gate in PUT /api/operations
  // (`if (person && STAGE_ROLES[stage])`) was falsy for it and ANY active worker
  // could be assigned to the delivery stage. Both the Production board and the
  // order page already showed "Packer" for it, so this makes the server agree
  // with what the UI has always claimed.
  DELIVERY: "Packer",
};

/** Position of a stage in the default route, or -1 when it is not one. */
export function stageIndex(stage: string | null | undefined): number {
  return stage ? (STAGES as readonly string[]).indexOf(stage) : -1;
}

/**
 * The stage that follows `stage` in the default route, or null at the end.
 *
 * POST /api/inspections uses this to move approved pieces forward. Task 3
 * replaces the argument with a garment's own route; the call sites stay the same.
 */
export function nextStage(stage: string | null | undefined): string | null {
  const index = stageIndex(stage);
  if (index < 0 || index >= STAGES.length - 1) return null;
  return STAGES[index + 1];
}

/**
 * The stage that precedes `stage` in the default route, or null at the start.
 * Used to bound a correction: a stage may never hold more than the stage before
 * it actually approved.
 */
export function previousStage(stage: string | null | undefined): string | null {
  const index = stageIndex(stage);
  return index > 0 ? STAGES[index - 1] : null;
}

/** True when a role is one of the production-stage roles. */
export function isProductionRole(role: string | null | undefined): boolean {
  return !!role && PRODUCTION_ROLES.some((known) => sameRole(known, role));
}

/**
 * Broad staff grouping shown in the Owner's staff list. A person may fall into
 * more than one, which is exactly why these are derived and not stored.
 */
export function staffCategories(roles: string[]): string[] {
  const categories: string[] = [];
  if (roles.some((role) => isProductionRole(role))) categories.push("Production Worker");
  if (roles.some((role) => sameRole(role, SUPPORT_ROLE))) categories.push("Support Worker");
  if (roles.some((role) => STAFF_POSITIONS.some((position) => sameRole(position, role))))
    categories.push("Salaried / Non-Production Staff");
  return categories;
}

/** Case/whitespace-insensitive role comparison. */
export function sameRole(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** True when `roles` contains `role`, ignoring case and surrounding spaces. */
export function hasRole(roles: (string | null | undefined)[], role: string): boolean {
  return roles.some((value) => sameRole(value, role));
}

/**
 * Client-side mirror of the server's effective-roles rule: the roles returned
 * by /api/workers, with the legacy specialty always counted.
 */
export function personRoles(person: { specialty?: string | null; roles?: string[] | null }): string[] {
  const listed = Array.isArray(person.roles) ? person.roles.filter((role): role is string => !!role) : [];
  const specialty = person.specialty;
  if (specialty && !hasRole(listed, specialty)) listed.push(specialty);
  return listed;
}

/** Does this person hold `role`? Used by every worker dropdown filter. */
export function personHoldsRole(
  person: { specialty?: string | null; roles?: string[] | null },
  role: string
): boolean {
  return hasRole(personRoles(person), role);
}

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
