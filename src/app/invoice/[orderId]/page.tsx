"use client";

import { use, useCallback, useEffect, useState } from "react";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { Letterhead, type LetterBusiness } from "@/components/documents/Letterhead";
import { PaginatedTable } from "@/components/documents/PaginatedTable";
import { SkeletonDocument, LoadError } from "@/components/Skeleton";
import { fmtDate, naira } from "@/lib/format";

type InvoiceItem = { description: string; quantity: number; unitPrice: number; total: number };
type InvoicePayment = { id: number; amount: number; date: string; method: string; reference: string | null };

type Invoice = {
  invoiceNo: string;
  order: {
    orderNumber: string;
    orderDate: string;
    totalAmount: number;
    itemsTotal: number;
    adjustment: number;
    paidTotal: number;
    outstanding: number;
  };
  items: InvoiceItem[];
  payments: InvoicePayment[];
  customer: { name: string; contactPerson: string | null; phone: string | null; email: string | null; address: string | null } | null;
  business: LetterBusiness | null;
};

/**
 * The printable invoice for an order.
 *
 * Hierarchy: who owes, what was ordered (line items), what it costs (totals
 * with any recorded adjustment made explicit), what has been paid (payment
 * history), what is outstanding - then payment instructions. All money
 * figures come straight from the existing order and payment records; long
 * item lists paginate automatically with repeated headers and page numbers.
 */
export default function InvoicePage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  const [document, setDocument] = useState<Invoice | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    fetch(`/api/invoices?orderId=${encodeURIComponent(orderId)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load the invoice.");
        return result as Invoice;
      })
      .then((result) => { if (active) setDocument(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load the invoice."); });
    return () => { active = false; };
  }, [orderId, reload]);

  const retry = useCallback(() => setReload((n) => n + 1), []);

  if (error)
    return (
      <div className="document-page min-h-screen bg-[#f2f3ee] p-4 sm:p-8">
        <div className="mx-auto max-w-[210mm]">
          <LoadError message={error} onRetry={retry}>
            <p className="mt-2 text-xs font-normal text-red-700">
              <a href="/login" className="font-semibold underline">Sign in</a> if your session has expired.
            </p>
          </LoadError>
        </div>
      </div>
    );
  if (!document)
    return (
      <main className="document-page min-h-screen bg-[#f2f3ee] px-3 py-6 sm:px-6">
        <SkeletonDocument label="Loading Matesther invoice…" rows={8} />
      </main>
    );

  const { invoiceNo, order, items, payments, customer, business } = document;
  const message = [
    `${business?.name || "Matesther Enterprises"} invoice ${invoiceNo}`,
    `School: ${customer?.name || "Customer"}`,
    `Order: ${order.orderNumber} dated ${fmtDate(order.orderDate)}`,
    `Invoice total: ${naira(order.totalAmount)}`,
    `Paid to date: ${naira(order.paidTotal)}`,
    `Outstanding: ${naira(order.outstanding)}`,
    `Please quote ${order.orderNumber} when paying. For the letterheaded PDF, ask Matesther to attach the printed invoice.`,
  ].join("\n");

  return (
    <main className="document-page min-h-screen bg-[#f2f3ee] px-3 py-6 sm:px-6">
      <DocumentActions title={`Matesther invoice ${invoiceNo}`} filename="invoice" customerEmail={customer?.email} customerPhone={customer?.phone} message={message} />
      <Letterhead business={business} ourRef={invoiceNo} yourRef={order.orderNumber} date={fmtDate(order.orderDate)} title="Invoice" subtitle={`Order ${order.orderNumber}`}>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Bill to</p>
            <p className="mt-1 font-semibold text-[#282b25]">{customer?.name || "Customer"}</p>
            {customer?.contactPerson && <p>Attention: {customer.contactPerson}</p>}
            {customer?.address && <p className="text-[#5a6056]">{customer.address}</p>}
            {customer?.email && <p className="text-[#5a6056]">{customer.email}</p>}
          </div>
          <div className="sm:text-right">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Invoice summary</p>
            <p className="mt-1">Invoice date: <strong>{fmtDate(order.orderDate)}</strong></p>
            <p>Invoice total: <strong>{naira(order.totalAmount)}</strong></p>
            <p>Outstanding: <strong className={order.outstanding > 0 ? "text-[#a4573c]" : "text-[#166b3d]"}>{naira(order.outstanding)}</strong></p>
          </div>
        </div>

        <h3 className="letter-section-title">Uniform items</h3>

        {/* Mobile: compact cards; screen (sm+) and print: paginated table. */}
        <div className="mt-3 space-y-2 sm:hidden">
          {items.map((item, index) => (
            <div key={`${item.description}-${index}`} className="rounded-lg border border-[#d8d3c4] bg-[#faf9f5] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wide text-[#6b6250]">#{index + 1} Item</p>
                  <p className="break-words font-semibold text-[#282b25]">{item.description}</p>
                </div>
                <p className="shrink-0 text-right">
                  <span className="block text-[10px] uppercase tracking-wide text-[#6b6250]">Total</span>
                  <span className="font-bold tabular-nums text-[#282b25]">{naira(item.total)}</span>
                </p>
              </div>
              <p className="mt-1 text-xs tabular-nums text-[#5a6056]">
                {item.quantity.toLocaleString()} × {naira(item.unitPrice)}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 hidden sm:block">
          <PaginatedTable
            rows={items}
            rowKey={(item, index) => `${item.description}-${index}`}
            rowsFirstPage={18}
            rowsPerPage={28}
            continuationLabel={`Invoice ${invoiceNo}`}
            footerLeft={`${invoiceNo} · Order ${order.orderNumber} · ${fmtDate(order.orderDate)}`}
            columns={[
              { header: "No.", widthClass: "w-12" },
              { header: "Description" },
              { header: "Quantity", align: "right", widthClass: "w-24" },
              { header: "Unit price", align: "right", widthClass: "w-28" },
              { header: "Total", align: "right", widthClass: "w-32" },
            ]}
            renderRow={(item, index) => (
              <>
                <td>{index + 1}</td>
                <td>{item.description}</td>
                <td>{item.quantity.toLocaleString()}</td>
                <td>{naira(item.unitPrice)}</td>
                <td className="font-semibold tabular-nums">{naira(item.total)}</td>
              </>
            )}
          />
        </div>

        {/* Totals: existing order rules, with any recorded adjustment explicit. */}
        <div className="letter-total-box mt-6">
          <dl className="space-y-1 text-xs text-[#4a4f45]">
            <div className="flex justify-between gap-4">
              <dt>Subtotal (items)</dt>
              <dd className="font-semibold tabular-nums">{naira(order.itemsTotal)}</dd>
            </div>
            {order.adjustment !== 0 && (
              <div className="flex justify-between gap-4">
                <dt>{order.adjustment < 0 ? "Discount / adjustment (as recorded on the order)" : "Adjustment (as recorded on the order)"}</dt>
                <dd className="font-semibold tabular-nums">{order.adjustment < 0 ? `−${naira(-order.adjustment)}` : naira(order.adjustment)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4 border-t border-[#cad2b0] pt-1 text-sm text-[#282b25]">
              <dt className="font-bold">Invoice total</dt>
              <dd className="font-bold tabular-nums">{naira(order.totalAmount)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Less amounts paid to date</dt>
              <dd className="font-semibold tabular-nums">−{naira(order.paidTotal)}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-[#cad2b0] pt-1 text-sm">
              <dt className="font-bold text-[#282b25]">Outstanding balance</dt>
              <dd className={`font-bold tabular-nums ${order.outstanding > 0 ? "text-[#a4573c]" : "text-[#166b3d]"}`}>{naira(order.outstanding)}</dd>
            </div>
          </dl>
        </div>

        {payments.length > 0 && (
          <>
            <h3 className="letter-section-title">Payments received</h3>
            <table className="letter-table">
              <thead>
                <tr><th className="w-28">Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{fmtDate(payment.date)}</td>
                    <td>{payment.method}</td>
                    <td>{payment.reference || "—"}</td>
                    <td className="tabular-nums">{naira(payment.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h3 className="letter-section-title">Payment instructions</h3>
        <div className="rounded-sm border border-[#cad2b0] bg-[#f9fbf4] p-4 text-xs leading-relaxed text-[#4a4f45]">
          <p>
            Please pay <strong className="text-[#282b25]">{business?.name || "Matesther Enterprises"}</strong>
            {order.outstanding > 0 ? <> the outstanding balance of <strong className="text-[#282b25]">{naira(order.outstanding)}</strong></> : " nothing further - this invoice is settled in full"}.
          </p>
          <p className="mt-2">
            Quote <strong className="text-[#282b25]">order {order.orderNumber}</strong> and invoice <strong className="text-[#282b25]">{invoiceNo}</strong> as the payment reference so the payment is matched to this invoice.
          </p>
          {business?.phone && <p className="mt-2">Tel: {business.phone}</p>}
          {business?.email && <p>Email: {business.email}</p>}
          {business?.address && <p>{business.address}</p>}
          <p className="mt-2">Transfer and cash payment details are confirmed directly with Matesther on request.</p>
        </div>

        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="border-b border-[#c9c3b2] pb-6 text-[11px] uppercase tracking-wide text-[#6b6250]">
              Prepared by (name, signature, date)
            </p>
          </div>
          <div>
            <p className="border-b border-[#c9c3b2] pb-6 text-[11px] uppercase tracking-wide text-[#6b6250]">
              For Matesther Enterprises (signature, date)
            </p>
          </div>
        </div>

        <p className="mt-6 text-[10px] leading-relaxed text-[#6b6250]">
          All amounts are in Nigerian naira. Line totals and the invoice total follow the order as recorded;
          taxes are not applicable to this order unless stated above. Thank you for choosing Matesther.
        </p>
      </Letterhead>
    </main>
  );
}
