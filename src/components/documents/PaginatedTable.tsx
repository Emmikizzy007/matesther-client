"use client";

import type { ReactNode } from "react";
import { chunkRows, DOC_ROWS_FIRST_PAGE, DOC_ROWS_PER_PAGE } from "@/lib/paginate";

export interface PaginatedColumn {
  header: string;
  /** Right-aligned columns (money, quantities). */
  align?: "left" | "right" | "center";
  widthClass?: string;
}

/**
 * The shared print table for the letterheaded documents.
 *
 * Long tables (60-100+ rows) are split into A4 sheets at render time: every
 * sheet repeats the table header, no row is ever split across sheets, and each
 * sheet footer carries "Page x of y" so the page numbers are part of the
 * generated PDF and the printout, not just the screen. The first sheet keeps
 * the letterhead, so it takes fewer rows; continuation sheets get a compact
 * running head with the document reference.
 */
export function PaginatedTable<T>({
  rows,
  columns,
  renderRow,
  rowKey,
  renderTotalRow,
  continuationLabel,
  footerLeft,
  rowsFirstPage = DOC_ROWS_FIRST_PAGE,
  rowsPerPage = DOC_ROWS_PER_PAGE,
}: {
  rows: readonly T[];
  columns: PaginatedColumn[];
  renderRow: (row: T, index: number) => ReactNode;
  rowKey: (row: T, index: number) => string | number;
  /** Optional grand-total row; printed once, at the foot of the last sheet. */
  renderTotalRow?: ReactNode;
  /** e.g. "Bank payment schedule MTH-PAY-2026-01" for continuation sheets. */
  continuationLabel?: string;
  footerLeft?: ReactNode;
  rowsFirstPage?: number;
  rowsPerPage?: number;
}) {
  const pages = chunkRows(rows, rowsFirstPage, rowsPerPage);
  if (pages.length === 0) return null;
  return (
    <div>
      {pages.map((page, pageIndex) => {
        const offset = pages.slice(0, pageIndex).reduce((sum, p) => sum + p.length, 0);
        return (
          <section key={pageIndex} className="print-page">
            {pageIndex > 0 && continuationLabel && (
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#6b6250]">
                {continuationLabel} (continued)
              </p>
            )}
            <table className="letter-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column.header}
                      className={`${column.widthClass ?? ""} ${column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : ""}`}
                    >
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.map((row, index) => (
                  <tr key={rowKey(row, offset + index)}>{renderRow(row, offset + index)}</tr>
                ))}
              </tbody>
              {pageIndex === pages.length - 1 && renderTotalRow ? <tfoot>{renderTotalRow}</tfoot> : null}
            </table>
            <footer className="print-page-footer">
              <span>{footerLeft}</span>
              <span>
                Page {pageIndex + 1} of {pages.length}
              </span>
            </footer>
          </section>
        );
      })}
    </div>
  );
}
