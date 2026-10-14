/**
 * Print pagination for the letterheaded documents (bank payment schedule,
 * delivery sheet, invoice).
 *
 * Documents are split into explicit page chunks so every printed sheet carries
 * its own table header and a "Page x of y" footer. The first sheet holds the
 * letterhead, so it takes fewer rows than the continuation sheets; both
 * capacities are deliberately conservative so a chunk never overflows its
 * sheet. Rows are never split: each row belongs to exactly one sheet.
 */

export type PageOfRows<T> = T[];

/** Split rows into print sheets: `firstPage` rows on sheet 1, `perPage` after. */
export function chunkRows<T>(rows: readonly T[], firstPage: number, perPage: number): PageOfRows<T>[] {
  if (firstPage < 1 || perPage < 1) throw new Error("Page capacities must be at least 1.");
  if (rows.length === 0) return [];
  const pages: T[][] = [];
  let index = 0;
  pages.push(rows.slice(0, firstPage) as T[]);
  index = firstPage;
  while (index < rows.length) {
    pages.push(rows.slice(index, index + perPage) as T[]);
    index += perPage;
  }
  return pages;
}

/**
 * Row capacities for A4 portrait at the print margins in globals.css.
 * ~6mm per compact row on continuation sheets, fewer on the letterheaded first
 * sheet. Tuned for legible 11-12px type - never shrink text to force one page.
 */
export const DOC_ROWS_FIRST_PAGE = 16;
export const DOC_ROWS_PER_PAGE = 28;
