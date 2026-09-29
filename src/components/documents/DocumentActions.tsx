"use client";

import { useState } from "react";
import { ArrowLeft, Copy, Mail, Printer, Share2 } from "lucide-react";

export function DocumentActions({
  title,
  filename,
  customerEmail,
  message,
}: {
  title: string;
  filename: string;
  customerEmail?: string | null;
  message: string;
}) {
  const [feedback, setFeedback] = useState("");
  const subject = encodeURIComponent(title);
  const body = encodeURIComponent(message);

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
        <button type="button" onClick={share} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          {typeof navigator !== "undefined" && typeof navigator.share === "function" ? <Share2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Share details
        </button>
        <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg bg-matesther-800 px-3 py-2 text-sm font-semibold text-white hover:bg-matesther-900">
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">For the letterheaded {filename}, choose Print / Save as PDF and attach the saved file to your message. Email details only opens a draft, it does not attach the PDF automatically.</p>
      {feedback && <p className="mt-2 text-xs font-semibold text-matesther-700" role="status">{feedback}</p>}
    </div>
  );
}
