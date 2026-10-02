"use client";

import { useState } from "react";
import { ArrowLeft, Copy, Mail, MessageCircle, Printer, Share2 } from "lucide-react";
import { hasWhatsappNumber, whatsappHref } from "@/lib/whatsapp";

export function DocumentActions({
  title,
  filename,
  customerEmail,
  customerPhone,
  message,
  sensitive = false,
}: {
  title: string;
  filename: string;
  customerEmail?: string | null;
  /** School/customer phone. With it, WhatsApp opens that chat directly. */
  customerPhone?: string | null;
  message: string;
  /**
   * Owner-only documents (the payroll payment sheet). Keeps the action
   * available to the Owner but says plainly that the content is confidential,
   * and never pre-selects a recipient.
   */
  sensitive?: boolean;
}) {
  const [feedback, setFeedback] = useState("");
  const subject = encodeURIComponent(title);
  const body = encodeURIComponent(message);
  // A plain link, not a JS action: it works with JavaScript disabled, on every
  // mobile browser, and hands straight over to the WhatsApp app. That is also
  // the fallback when the Web Share API is unavailable.
  const whatsapp = whatsappHref(message, sensitive ? null : customerPhone);
  const directChat = !sensitive && hasWhatsappNumber(customerPhone);

  async function share() {
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, text: message });
        setFeedback("Details shared. To send the full letterheaded PDF, save it with Print / Save as PDF.");
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(message);
        setFeedback("Details copied. You can paste them into WhatsApp or an email.");
      } else {
        setFeedback("Use Print / Save as PDF, then attach the file when sending it.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setFeedback("Could not share from this browser. Try Print / Save as PDF.");
    }
  }

  return (
    <div className="document-actions no-print mx-auto mb-5 max-w-[210mm] rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => history.back()} className="mr-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        {customerEmail && (
          <a href={`mailto:${encodeURIComponent(customerEmail)}?subject=${subject}&body=${body}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <Mail className="h-4 w-4" /> Email details
          </a>
        )}
        <a
          href={whatsapp}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={sensitive ? "Share this document on WhatsApp" : "Send this document on WhatsApp"}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
        >
          <MessageCircle className="h-4 w-4" /> {directChat ? "WhatsApp school" : "WhatsApp"}
        </a>
        <button type="button" onClick={share} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          {typeof navigator !== "undefined" && typeof navigator.share === "function" ? <Share2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Share details
        </button>
        <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg bg-matesther-800 px-3 py-2 text-sm font-semibold text-white hover:bg-matesther-900">
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">For the letterheaded {filename}, choose Print / Save as PDF and attach the saved file to your message. WhatsApp and Email send the text details only, not the PDF.</p>
      {sensitive && (
        <p className="mt-1 text-xs font-semibold text-red-700">
          This sheet contains confidential salary information. WhatsApp opens with no recipient chosen - check who you are sending it to before you press send.
        </p>
      )}
      {feedback && <p className="mt-2 text-xs font-semibold text-matesther-700" role="status">{feedback}</p>}
    </div>
  );
}
