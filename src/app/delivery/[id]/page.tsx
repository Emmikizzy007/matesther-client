"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { Letterhead, type LetterBusiness } from "@/components/documents/Letterhead";
import { PaginatedTable } from "@/components/documents/PaginatedTable";
import { SkeletonDocument, LoadError } from "@/components/Skeleton";
import { fmtDate } from "@/lib/format";

type DeliveryLine = { description: string; colour: string | null; size: string | null; quantity: number };

type DeliveryNote = {
  delivery: {
    id: number; deliveryNumber: string; deliveryDate: string; deliveredQuantity: number;
    recipient: string | null; deliveryAddress: string | null; notes: string | null; status: string;
  };
  lines: DeliveryLine[];
  legacySummary: boolean;
  order: { orderNumber: string; orderDate: string; orderedQuantity: number; shippedBefore: number; remainingAfter: number };
  customer: { name: string; contactPerson: string | null; phone: string | null; email: string | null; address: string | null } | null;
  business: LetterBusiness | null;
};

export default function DeliverySheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [document, setDocument] = useState<DeliveryNote | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    fetch(`/api/deliveries?deliveryId=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load the delivery sheet.");
        return result as DeliveryNote;
      })
      .then((result) => { if (active) setDocument(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load this delivery."); });
    return () => { active = false; };
  }, [id, reload]);

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
        <SkeletonDocument label="Loading Matesther delivery sheet…" rows={8} />
      </main>
    );

  const { delivery, order, customer, business, lines, legacySummary } = document;
  const message = [
    `${business?.name || "Matesther Enterprises"} delivery sheet ${delivery.deliveryNumber}`,
    `School: ${customer?.name || "Customer"}`,
    `Order: ${order.orderNumber}`,
    `Delivery date: ${fmtDate(delivery.deliveryDate)}`,
    ...lines.map((line) => `${line.description}${line.colour ? `, ${line.colour}` : ""}${line.size ? `, size ${line.size}` : ""}: ${line.quantity} pcs`),
    `Total delivered: ${delivery.deliveredQuantity} garments`,
    `For a signed letterheaded copy, ask Matesther to attach the printed delivery sheet.`,
  ].join("\n");

  return (
    <main className="document-page min-h-screen bg-[#f2f3ee] px-3 py-6 sm:px-6">
      <DocumentActions title={`Matesther delivery sheet ${delivery.deliveryNumber}`} filename="delivery sheet" customerEmail={customer?.email} customerPhone={customer?.phone} message={message} />
      <Letterhead business={business} ourRef={delivery.deliveryNumber} yourRef={order.orderNumber} date={fmtDate(delivery.deliveryDate)} title="School Uniform Delivery Sheet" subtitle={`Order ${order.orderNumber} | ${customer?.name || "School"}`}>
        <DeliveryBody
          delivery={delivery}
          order={order}
          customer={customer}
          lines={lines}
          legacySummary={legacySummary}
        />
      </Letterhead>
    </main>
  );
}

function DeliveryBody({
  delivery,
  order,
  customer,
  lines,
  legacySummary,
}: {
  delivery: DeliveryNote["delivery"];
  order: DeliveryNote["order"];
  customer: DeliveryNote["customer"];
  lines: DeliveryLine[];
  legacySummary: boolean;
}) {
  // Totals per product (garment), for reconciliation against the order.
  const productTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const line of lines) totals.set(line.description, (totals.get(line.description) ?? 0) + line.quantity);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [lines]);

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Delivered to</p>
          <p className="mt-1 font-semibold text-[#282b25]">{customer?.name || "School"}</p>
          {customer?.contactPerson && <p>Attention: {customer.contactPerson}</p>}
          <p className="text-[#5a6056]">{delivery.deliveryAddress || customer?.address || "Address not recorded"}</p>
        </div>
        <div className="sm:text-right">
          <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Consignment</p>
          <p className="mt-1">Delivery date: <strong>{fmtDate(delivery.deliveryDate)}</strong></p>
          <p>Delivery status: <strong>{delivery.status === "PARTIAL" ? "Part delivery" : delivery.status === "DELIVERED" ? "Delivered" : delivery.status}</strong></p>
          {delivery.recipient && <p>Named recipient: <strong>{delivery.recipient}</strong></p>}
        </div>
      </div>

      <h3 className="letter-section-title">Details of uniforms handed over</h3>

      {/* Mobile: one compact card per variant - no whole-page horizontal scroll. */}
      <div className="mt-3 space-y-2 sm:hidden">
        {lines.map((line, index) => (
          <div key={`${line.description}-${line.colour ?? ""}-${line.size ?? ""}-${index}`} className="rounded-lg border border-[#d8d3c4] bg-[#faf9f5] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-[#6b6250]">#{index + 1} Garment</p>
                <p className="break-words font-semibold text-[#282b25]">{line.description}</p>
              </div>
              <p className="shrink-0 text-right">
                <span className="block text-[10px] uppercase tracking-wide text-[#6b6250]">Qty</span>
                <span className="font-bold tabular-nums text-[#282b25]">{line.quantity.toLocaleString()}</span>
              </p>
            </div>
            <p className="mt-1 text-xs text-[#5a6056]">
              {line.colour ? `Colour: ${line.colour} · ` : ""}Size: {line.size || "Assorted"}
            </p>
          </div>
        ))}
        <div className="rounded-lg border-t-2 border-[#987048] bg-[#f6f4ee] p-3">
          <p className="flex items-center justify-between font-bold text-[#282b25]">
            <span>Total handed over</span>
            <span className="tabular-nums">{delivery.deliveredQuantity.toLocaleString()} pcs</span>
          </p>
        </div>
      </div>

      {/* Screen (sm+) and print: paginated table, repeated headers, page numbers. */}
      <div className="mt-3 hidden sm:block">
        <PaginatedTable
          rows={lines}
          rowKey={(line, index) => `${line.description}-${line.colour ?? ""}-${line.size ?? ""}-${index}`}
          rowsFirstPage={18}
          rowsPerPage={28}
          continuationLabel={`Delivery sheet ${delivery.deliveryNumber}`}
          footerLeft={`MTH-DLV · Order ${order.orderNumber} · ${fmtDate(delivery.deliveryDate)}`}
          columns={[
            { header: "No.", widthClass: "w-12" },
            { header: "Garment / school uniform" },
            { header: "Colour", widthClass: "w-28" },
            { header: "Size", widthClass: "w-24" },
            { header: "Quantity", align: "right", widthClass: "w-24" },
          ]}
          renderRow={(line, index) => (
            <>
              <td>{index + 1}</td>
              <td>{line.description}</td>
              <td>{line.colour || "—"}</td>
              <td>{line.size || "Assorted"}</td>
              <td>{line.quantity.toLocaleString()}</td>
            </>
          )}
          renderTotalRow={
            <tr>
              <td colSpan={4}>Total handed over on this delivery</td>
              <td>{delivery.deliveredQuantity.toLocaleString()} pcs</td>
            </tr>
          }
        />
      </div>
      {legacySummary && <p className="mt-2 text-[11px] italic text-[#77796e]">This delivery was recorded before individual garment and size lines were captured. The original quantity is preserved; the item breakdown is not available.</p>}

      {/* Product totals for reconciliation against the order. */}
      {productTotals.length > 1 && (
        <div className="mt-4 rounded-sm border border-[#d8d3c4] bg-[#faf9f5] p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-[#6b6250]">Total per product</p>
          <ul className="mt-1 grid grid-cols-1 gap-x-6 text-xs text-[#4a4f45] sm:grid-cols-2">
            {productTotals.map(([description, quantity]) => (
              <li key={description} className="flex justify-between gap-3 border-b border-dashed border-[#e6e2d6] py-1">
                <span className="min-w-0 break-words">{description}</span>
                <span className="shrink-0 font-semibold tabular-nums">{quantity.toLocaleString()} pcs</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-7 grid gap-3 rounded-sm border border-[#cad2b0] bg-[#f9fbf4] p-4 text-xs sm:grid-cols-4">
        <div><p className="font-semibold text-[#6a7859]">Order quantity</p><p className="mt-1 text-base font-bold">{order.orderedQuantity.toLocaleString()}</p></div>
        <div><p className="font-semibold text-[#6a7859]">Delivered previously</p><p className="mt-1 text-base font-bold">{order.shippedBefore.toLocaleString()}</p></div>
        <div><p className="font-semibold text-[#6a7859]">This delivery</p><p className="mt-1 text-base font-bold">{delivery.deliveredQuantity.toLocaleString()}</p></div>
        <div><p className="font-semibold text-[#6a7859]">Still to deliver</p><p className="mt-1 text-base font-bold">{order.remainingAfter.toLocaleString()}</p></div>
      </div>
      {delivery.notes && <p className="mt-5 text-xs text-[#565d51]"><strong>Delivery notes:</strong> {delivery.notes}</p>}
      <p className="mt-7 font-serif text-[15px] font-semibold">Acknowledgement of receipt</p>
      <p className="text-xs text-[#687064]">Please check the garments and quantities above and sign below to confirm receipt. A digital record alone does not replace the school signature.</p>
      <div className="mt-12 grid grid-cols-2 gap-12 text-xs text-[#5b6257]">
        <div><div className="border-t border-[#7e8874] pt-2">Delivered by (name and signature)</div><p className="mt-3">Date: ______________________</p></div>
        <div><div className="border-t border-[#7e8874] pt-2">Received by school (name and signature)</div><p className="mt-3">Date / School stamp: ______________________</p></div>
      </div>
      <p className="mt-10 font-serif text-sm font-semibold">Thank you for choosing Matesther.</p>
    </>
  );
}
