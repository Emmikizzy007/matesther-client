"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertCircle, RefreshCw } from "lucide-react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Matesther page error", error);
  }, [error]);

  return (
    <div className="mx-auto mt-12 max-w-lg rounded-xl border border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
        <AlertCircle className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-lg font-semibold text-slate-900">This page could not load</h1>
      <p className="mt-2 text-sm text-slate-600">Your records are still saved. Please try again. If the issue continues, sign out and sign back in.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={reset} className="inline-flex items-center gap-2 rounded-lg bg-matesther-800 px-4 py-2 text-sm font-semibold text-white hover:bg-matesther-900">
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
        <Link href="/dashboard" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Dashboard</Link>
      </div>
    </div>
  );
}
