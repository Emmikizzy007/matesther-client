"use client";

import { use, useEffect, useState } from "react";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { Letterhead, type LetterBusiness } from "@/components/documents/Letterhead";
import { fmtDate } from "@/lib/format";

type DeliveryNote = {
  delivery: {
    id: number; deliveryNumber: string; deliveryDate: string; deliveredQuantity: number;
    recipient: string | null; deliveryAddress: string | null; notes: string | null; status: string;
  };
  lines: { description: string; size: string | null; quantity: number }[];
  legacySummary: boolean;
  order: { orderNumber: string; orderDate: string; orderedQuantity: number; shippedBefore: number; remainingAfter: number };
  customer: { name: string; contactPerson: string | null; phone: string | null; email: string | null; address: string | null } | null;
  business: LetterBusiness | null;
};

export default function DeliverySheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [document, setDocument] = useState<DeliveryNote | null>(null);
  const [error, setError] = useState("");

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
  }, [id]);

  if (error) return <main className="document-page min-h-screen bg-[#f2f3ee] p-8 text-center text-sm text-red-700" role="alert">{error} <a href="/login" className="underline">Sign in</a> if your session has expired.</main>;
  if (!document) return <main className="document-page min-h-screen bg-[#f2f3ee] p-8 text-center text-sm text-slate-500">Loading Matesther delivery sheet...</main>;

  const { delivery, order, customer, business, lines, legacySummary } = document;
  const message = [
    `${business?.name || "Matesther Enterprises"} delivery sheet ${delivery.deliveryNumber}`,
    `School: ${customer?.name || "Customer"}`,
    `Order: ${order.orderNumber}`,
    `Delivery date: ${fmtDate(delivery.deliveryDate)}`,
    ...lines.map((line) => `${line.description}${line.size ? `, size ${line.size}` : ""}: ${line.quantity} pcs`),
    `Total delivered: ${delivery.deliveredQuantity} garments`,
    `For a signed letterheaded copy, ask Matesther to attach the printed delivery sheet.`,
  ].join("\n");

  return (
    <main className="document-page min-h-screen bg-[#f2f3ee] px-3 py-6 sm:px-6">
      <DocumentActions title={`Matesther delivery sheet ${delivery.deliveryNumber}`} filename="delivery sheet" customerEmail={customer?.email} customerPhone={customer?.phone} message={message} />
      <Letterhead business={business} ourRef={delivery.deliveryNumber} yourRef={order.orderNumber} date={fmtDate(delivery.deliveryDate)} title="School Uniform Delivery Sheet" subtitle={`Order ${order.orderNumber} | ${customer?.name || "School"}`}>
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
        <table className="letter-table">
          <thead><tr><th className="w-10">No.</th><th>Garment / school uniform</th><th className="w-24">Size</th><th className="w-24">Quantity</th></tr></thead>
          <tbody>
            {lines.map((line, index) => <tr key={`${line.description}-${line.size ?? ""}-${index}`}>
              <td>{index + 1}</td><td>{line.description}</td><td>{line.size || "Assorted"}</td><td>{line.quantity.toLocaleString()}</td>
            </tr>)}
          </tbody>
          <tfoot><tr><td colSpan={3}>Total handed over on this delivery</td><td>{delivery.deliveredQuantity.toLocaleString()} pcs</td></tr></tfoot>
        </table>
        {legacySummary && <p className="mt-2 text-[11px] italic text-[#77796e]">This delivery was recorded before individual garment and size lines were captured. The original quantity is preserved; the item breakdown is not available.</p>}

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
      </Letterhead>
    </main>
  );
}
