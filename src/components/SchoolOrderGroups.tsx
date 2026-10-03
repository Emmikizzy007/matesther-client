"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, School } from "lucide-react";
import Link from "next/link";
import { Card, EmptyState } from "@/components/ui";
import { useAuth } from "@/lib/auth";

type Groupable = { id: number; orderId: number | null; orderNumber: string; customer: string };

/** One expandable card per school order, shared by production lists and history. */
export function SchoolOrderGroups<T extends Groupable>({
  rows, renderItem, emptyTitle, emptyHint, itemLabel = "job", children,
}: {
  rows: T[];
  renderItem: (row: T) => ReactNode;
  emptyTitle: string;
  emptyHint?: string;
  itemLabel?: string;
  children?: ReactNode;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { user } = useAuth();
  /**
   * Grouping is memoised on `rows`.
   *
   * This component rebuilt the map and re-sorted it on EVERY render - including
   * the render caused by merely expanding or collapsing a card, which changes no
   * data at all. With a few thousand jobs on the Production History page that was
   * an O(n log n) sort per click.
   */
  const groups = useMemo(() => {
    const byOrder = new Map<string, { school: string; orderNumber: string; orderId: number | null; rows: T[] }>();
    for (const row of rows) {
      const key = row.orderId ? String(row.orderId) : `${row.customer}-${row.orderNumber}`;
      const entry = byOrder.get(key) ?? { school: row.customer, orderNumber: row.orderNumber, orderId: row.orderId, rows: [] };
      entry.rows.push(row);
      byOrder.set(key, entry);
    }
    return [...byOrder.entries()].sort((a, b) => a[1].school.localeCompare(b[1].school) || a[1].orderNumber.localeCompare(b[1].orderNumber));
  }, [rows]);
  if (!groups.length) return <Card><EmptyState title={emptyTitle} hint={emptyHint} /></Card>;

  return <div className="space-y-3">
    {children}
    {groups.map(([key, group], index) => {
      const open = openKey === key || (openKey === null && index === 0);
      return <Card key={key} className="overflow-hidden">
        <button type="button" aria-expanded={open} onClick={() => setOpenKey(open ? "" : key)}
          className="flex min-h-[76px] w-full items-center justify-between gap-3 p-4 text-left hover:bg-slate-50 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="rounded-lg bg-matesther-50 p-2.5 text-matesther-800"><School className="h-5 w-5" /></span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-900 sm:text-base">{group.school}</p>
              <p className="mt-0.5 text-xs text-slate-500">{group.orderNumber} <span className="mx-1">•</span> {group.rows.length} {itemLabel}{group.rows.length === 1 ? "" : "s"}</p>
            </div>
          </div>
          <ChevronDown className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && <div className="border-t border-slate-100">
          <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-2">{group.rows.map((row) => <div key={row.id} className="min-w-0">{renderItem(row)}</div>)}</div>
          {group.orderId && user?.role === "OWNER" && <div className="border-t border-slate-100 px-4 py-3 text-right"><Link href={`/orders/${group.orderId}`} className="text-xs font-semibold text-matesther-700 hover:underline">Open full order →</Link></div>}
        </div>}
      </Card>;
    })}
  </div>;
}
