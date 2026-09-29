"use client";

import React, { ReactNode } from "react";
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
      className={`bg-white rounded-xl border border-slate-200 shadow-[0_1px_3px_rgba(0,0,0,0.05)] ${className}`}
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
    <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-100">
      <div>
        <h3 className="font-semibold text-slate-900 text-[15px]">{title}</h3>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {action}
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
      className={`rounded-xl border bg-white p-4 flex items-start gap-3 transition-all ${
        href
          ? "border-slate-200 hover:border-matesther-600 hover:shadow-md cursor-pointer"
          : "border-slate-200 shadow-[0_1px_3px_rgba(0,0,0,0.05)]"
      }`}
    >
      <div
        className={`w-10 h-10 rounded-lg ${tones[tone]} text-white flex items-center justify-center shrink-0`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {label}
        </p>
        <p className="text-xl font-bold text-slate-900 truncate">{value}</p>
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
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-950/50"
        onClick={onClose}
      />
      <div
        className={`relative bg-white rounded-xl shadow-2xl w-full ${
          wide ? "max-w-3xl" : "max-w-lg"
        } max-h-[92vh] overflow-y-auto slim-scroll fade-up`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white rounded-t-xl">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
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
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-matesther-700/40 focus:border-matesther-700 bg-white";

export function Btn({
  children,
  onClick,
  variant = "primary",
  type = "button",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
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
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${styles[variant]} ${className}`}
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
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && (
          <p className="text-sm text-slate-500 mt-1">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex gap-2">{action}</div>}
    </div>
  );
}
