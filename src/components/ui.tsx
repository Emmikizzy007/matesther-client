"use client";

import React, { ReactNode, useEffect } from "react";
import Link from "next/link";
import { statusColor } from "@/lib/format";
import { Loader2 } from "lucide-react";

/* ---------- Card ---------- */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`min-w-0 rounded-xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.05)] ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 pb-3 pt-4 sm:flex-nowrap sm:px-5">
      <div className="min-w-0 flex-1">
        <h3 className="break-words text-[15px] font-semibold text-slate-900">{title}</h3>
        {subtitle && <p className="mt-0.5 break-words text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/* ---------- Stat card (clickable when href is given) ---------- */
export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = "green",
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: ReactNode;
  tone?: "green" | "gold" | "blue" | "red" | "slate";
  href?: string;
}) {
  const tones: Record<string, string> = {
    green: "bg-matesther-800",
    gold: "bg-gold-500",
    blue: "bg-blue-700",
    red: "bg-red-700",
    slate: "bg-slate-700",
  };
  const card = (
    <div
      className={`flex min-w-0 items-start gap-2 rounded-xl border bg-white p-3 transition-all sm:gap-3 sm:p-4 ${
        href
          ? "border-slate-200 hover:border-matesther-600 hover:shadow-md cursor-pointer"
          : "border-slate-200 shadow-[0_1px_3px_rgba(0,0,0,0.05)]"
      }`}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white sm:h-10 sm:w-10 ${tones[tone]}`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {label}
        </p>
        <p className="break-words text-[clamp(0.95rem,3.8vw,1.25rem)] font-bold leading-tight tracking-tight text-slate-900">{value}</p>
        {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
        {href && (
          <p className="text-[10px] font-bold text-matesther-700 mt-1 opacity-0 transition-opacity group-hover:opacity-100">
            View records →
          </p>
        )}
      </div>
    </div>
  );
  if (href) {
    return (
      <Link href={href} className="group block">
        {card}
      </Link>
    );
  }
  return card;
}

/* ---------- Status badge ---------- */
export function Badge({ status }: { status: string }) {
  const label = (status || "-").replace(/_/g, " ");
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${statusColor(
        status
      )}`}
    >
      {label}
    </span>
  );
}

/* ---------- Progress bar ---------- */
export function ProgressBar({
  pct,
  className = "",
}: {
  pct: number;
  className?: string;
}) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className={`w-full bg-slate-100 rounded-full h-2 ${className}`}>
      <div
        className="bg-matesther-700 h-2 rounded-full transition-all"
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

/* ---------- Modal ---------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-slate-950/60" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={title}
        className={`relative max-h-[96dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl bg-white shadow-2xl slim-scroll fade-up sm:max-h-[92dvh] sm:rounded-xl ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-slate-100 bg-white px-4 py-3 sm:px-5 sm:py-4">
          <h3 className="min-w-0 break-words text-sm font-semibold text-slate-900 sm:text-base">{title}</h3>
          <button type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-2xl text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Close dialog">×</button>
        </div>
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Form bits ---------- */
export function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputCls =
  "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base outline-none focus:border-matesther-700 focus:ring-2 focus:ring-matesther-700/40 sm:text-sm";

/**
 * The one button. Renders an <a> through next/link when given an `href`, and a
 * <button> otherwise.
 *
 * WHY `href` EXISTS
 *   Several actions in this app are navigation, not mutation - "Start Production" on an
 *   order opens the Assign Production workflow for that order, and a document's "back to
 *   the order" goes back. Faking navigation with onClick + router.push loses what a real
 *   link gives for free on the phones this ERP is used on: middle-click and long-press to
 *   open in a new tab, the destination shown before it is tapped, browser back, and
 *   working at all before the JavaScript has hydrated.
 *
 *   It also keeps the styling in one place, so a link that looks like a button and a
 *   button are the same component rather than two copies of the same class list drifting
 *   apart. The tap target and text size are the mobile ones every control here uses.
 */
export function Btn({
  children,
  onClick,
  href,
  variant = "primary",
  type = "button",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  /** When present this is a link, not a button. */
  href?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "gold";
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
}) {
  const styles: Record<string, string> = {
    primary: "bg-matesther-800 hover:bg-matesther-900 text-white",
    gold: "bg-gold-500 hover:bg-gold-600 text-white",
    secondary: "bg-white border border-slate-300 hover:bg-slate-50 text-slate-700",
    danger: "bg-red-700 hover:bg-red-800 text-white",
    ghost: "text-slate-600 hover:bg-slate-100",
  };
  const classes = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`;
  if (href) {
    // A disabled link is rendered as a button that does nothing, because an <a> with
    // aria-disabled still navigates: pretending otherwise would be worse than either.
    if (disabled)
      return (
        <button type="button" disabled className={classes}>
          {children}
        </button>
      );
    return (
      <Link href={href} onClick={onClick} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={classes}
    >
      {children}
    </button>
  );
}

/* ---------- Loading / Empty ---------- */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-slate-500 text-sm">
      <Loader2 className="w-4 h-4 animate-spin" /> {label}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="py-10 text-center">
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-60">
        <h1 className="break-words text-xl font-bold text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 break-words text-sm leading-relaxed text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{action}</div>}
    </div>
  );
}
