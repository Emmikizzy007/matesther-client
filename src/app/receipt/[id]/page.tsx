"use client";

import { use, useEffect, useState } from "react";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { Letterhead, type LetterBusiness } from "@/components/documents/Letterhead";
import { fmtDate, naira } from "@/lib/format";

type Receipt = {
  receiptNo: string;
  payment: { amount: number; date: string; method: string; reference: string | null; notes: string | null };
  order: { orderNumber: string; orderDate: string; totalAmount: number; paidToDate: number; balanceBefore: number; balanceAfter: number };
  customer: { name: string; contactPerson: string | null; email: string | null; address: string | null; phone: string | null } | null;
  business: LetterBusiness | null;
  items: { description: string; quantity: number; unitPrice: number; total: number }[];
};

export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [document, setDocument] = useState<Receipt | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`/api/receipts?paymentId=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load the payment receipt.");
        return result as Receipt;
      })
      .then((result) => { if (active) setDocument(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load the receipt."); });
    return () => { active = false; };
  }, [id]);

  if (error) return <div className="document-page min-h-screen bg-[#f2f3ee] p-8 text-center text-sm text-red-700" role="alert">{error} <a href="/login" className="underline">Sign in</a> if your session has expired.</div>;
  if (!document) return <div className="document-page min-h-screen bg-[#f2f3ee] p-8 text-center text-sm text-slate-500">Loading Matesther receipt...</div>;

  const { receiptNo, payment, order, customer, business, items } = document;
  const note = [
    `${business?.name || "Matesther Enterprises"} payment receipt ${receiptNo}`,
    `School: ${customer?.name || "Customer"}`,
    `Order: ${order.orderNumber}`,
    `Date: ${fmtDate(payment.date)}`,
    `Payment received: ${naira(payment.amount)} by ${payment.method}`,
    `Balance after this payment: ${naira(order.balanceAfter)}`,
    `To receive the letterheaded PDF, ask Matesther to attach the printed receipt.`,
  ].join("\n");

  return (
    <main className="document-page min-h-screen bg-[#f2f3ee] px-3 py-6 sm:px-6">
      <DocumentActions title={`Matesther payment receipt ${receiptNo}`} filename="receipt" customerEmail={customer?.email} message={note} />
      <Letterhead business={business} ourRef={receiptNo} yourRef={payment.reference || order.orderNumber} date={fmtDate(payment.date)} title="Payment Receipt" subtitle={`Payment received for order ${order.orderNumber}`}>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Received from</p>
            <p className="mt-1 font-semibold text-[#282b25]">{customer?.name || "Customer"}</p>
            {customer?.contactPerson && <p>{customer.contactPerson}</p>}
            {customer?.address && <p className="text-[#5a6056]">{customer.address}</p>}
            {customer?.email && <p className="text-[#5a6056]">{customer.email}</p>}
          </div>
          <div className="sm:text-right">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#987048]">Payment details</p>
            <p className="mt-1">Method: <strong>{payment.method}</strong></p>
            <p>Order date: {fmtDate(order.orderDate)}</p>
            {payment.reference && <p>Bank/reference: <strong>{payment.reference}</strong></p>}
          </div>
        </div>

        <h3 className="letter-section-title">Uniform order details</h3>
        <p className="text-xs text-[#656a5f]">These items describe the order. This receipt acknowledges the payment below, not a new shipment.</p>
        <table className="letter-table">
          <thead><tr><th>Garment</th><th className="text-center">Qty</th><th className="text-right">Unit price</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {items.map((item, index) => <tr key={`${index}-${item.description}`}>
              <td>{item.description}</td><td className="text-center">{item.quantity.toLocaleString()}</td>
              <td className="text-right">{naira(item.unitPrice)}</td><td>{naira(item.total)}</td>
            </tr>)}
            {items.length === 0 && <tr><td colSpan={4}>Order {order.orderNumber}</td></tr>}
          </tbody>
          <tfoot><tr><td colSpan={3}>Order value</td><td>{naira(order.totalAmount)}</td></tr></tfoot>
        </table>

        <div className="letter-total-box ml-auto mt-7 max-w-[350px] space-y-2 rounded-sm text-sm">
          <div className="flex justify-between gap-4"><span>Balance before payment</span><strong>{naira(order.balanceBefore)}</strong></div>
          <div className="flex justify-between gap-4 border-b border-[#a9bd75] pb-2 font-bold text-[#32523b]"><span>Payment received</span><span>{naira(payment.amount)}</span></div>
          <div className="flex justify-between gap-4 text-base font-bold"><span>Balance after payment</span><span>{naira(order.balanceAfter)}</span></div>
        </div>
        {payment.notes && <p className="mt-6 text-xs text-[#62695c]">Payment note: {payment.notes}</p>}
        <p className="mt-8 font-serif text-[15px] font-semibold">Thank you for your payment.</p>
        <p className="mt-1 text-xs text-[#6a7063]">Please retain this receipt for your school's records.</p>
      </Letterhead>
    </main>
  );
}
