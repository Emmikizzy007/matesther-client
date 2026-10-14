"use client";

import type { ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * Facebook-style skeleton loaders.
 *
 * Every shape here is a shimmering grey block sized like the content it stands
 * in for (stat cards, table rows, form fields, document sheets), so the page
 * does not jump when the real data lands. Rules the whole app follows:
 *
 * - skeletons are aria-hidden decoration around a polite "Loading …" status;
 * - `prefers-reduced-motion` turns the shimmer into a static block;
 * - a skeleton is ALWAYS replaced by content or by <LoadError> when the
 *   request settles - never left on screen after the response, never padded
 *   with an artificial delay;
 * - every error state offers the reason and a Retry action.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton-block ${className}`} />;
}

export function SkeletonText({ lines = 2, className = "" }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

/** Wraps any skeleton region with the accessible loading announcement. */
export function SkeletonRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Stand-in for one Card/StatCard. */
export function SkeletonCard({ className = "" }: { className?: string }) {
  return <Skeleton className={`h-[104px] rounded-xl ${className}`} />;
}

/** The dashboard card grid: same responsive columns as the real stat grids. */
export function SkeletonStatGrid({ count = 6, label = "Loading dashboard cards…" }: { count?: number; label?: string }) {
  return (
    <SkeletonRegion label={label}>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: count }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Table/list placeholder: a header bar plus `rows` shimmering rows. */
export function SkeletonTable({
  rows = 6,
  cols = 4,
  label = "Loading records…",
  className = "",
  bare = false,
}: {
  rows?: number;
  cols?: number;
  label?: string;
  className?: string;
  /** For use inside an existing Card: no extra border/box. */
  bare?: boolean;
}) {
  return (
    <SkeletonRegion label={label}>
      <div className={`${bare ? "p-4" : "rounded-xl border border-slate-200 bg-white p-4"} ${className}`}>
        <Skeleton className="mb-4 h-8 w-full rounded-lg" />
        <div className="space-y-3">
          {Array.from({ length: rows }, (_, r) => (
            <div key={r} className="flex items-center gap-3">
              {Array.from({ length: cols }, (_, c) => (
                <Skeleton
                  key={c}
                  className={`h-4 flex-1 ${c === cols - 1 ? "max-w-[90px]" : ""}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** Settings-style content: a form card plus list rows. */
export function SkeletonForm({ label = "Loading settings…" }: { label?: string }) {
  return (
    <SkeletonRegion label={label}>
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <Skeleton className="mb-4 h-5 w-40" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-11 w-full rounded-lg" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <Skeleton className="mb-3 h-5 w-36" />
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** Letterheaded document placeholder (delivery sheet, invoice, bank schedule). */
export function SkeletonDocument({ label = "Loading document…", rows = 8 }: { label?: string; rows?: number }) {
  return (
    <SkeletonRegion label={label}>
      <div className="mx-auto w-full max-w-[210mm] rounded-sm bg-white p-6 shadow-sm">
        <div className="flex flex-col items-center gap-2">
          <Skeleton className="h-[60px] w-[60px] rounded-sm" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="my-4 h-1.5 w-full rounded-none" />
        <Skeleton className="mx-auto mb-5 h-6 w-64" />
        <div className="space-y-2.5">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
        <div className="mt-8 grid grid-cols-2 gap-8">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** The shared failure state: what broke, and a Retry that re-runs the load. */
export function LoadError({
  message,
  onRetry,
  children,
}: {
  message: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
      <p className="flex items-start gap-2 font-semibold">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
      </p>
      {children}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
        >
          <RotateCcw className="h-4 w-4" /> Try again
        </button>
      )}
    </div>
  );
}
