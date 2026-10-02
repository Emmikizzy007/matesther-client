"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, Lock, Mail, UserRound } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/lib/auth";
import { MATESTHER_MOTTO } from "@/lib/brand";

type Status = { hasUsers: boolean; setupReady: boolean };

export default function LoginPage() {
  const { user, loading: checkingSession, loginWithPassword } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!checkingSession && user) router.replace("/dashboard");
  }, [checkingSession, user, router]);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setStatusError("");
    fetch("/api/auth/status", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to connect to Matesther.");
        return result as Status;
      })
      .then((result) => { if (active) setStatus(result); })
      .catch((cause) => { if (active) setStatusError(cause instanceof Error ? cause.message : "Unable to connect to Matesther."); });
    return () => { active = false; };
  }, [attempt]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status) return;
    setError("");
    setBusy(true);
    try {
      if (!status.hasUsers) {
        if (password !== confirmPassword) throw new Error("Passwords do not match.");
        const response = await fetch("/api/auth/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, password, setupKey }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Account creation failed.");
        setStatus({ ...status, hasUsers: true });
        setSetupKey("");
        setConfirmPassword("");
      }
      await loginWithPassword(email.trim(), password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again.");
      setBusy(false);
    }
  }

  const firstSetup = status !== null && !status.hasUsers;
  const inputClass = "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base outline-none transition-colors focus:border-matesther-700 focus:ring-2 focus:ring-matesther-700/20 sm:text-sm";

  return (
    <div className="flex min-h-screen items-center justify-center bg-matesther-950 px-4 py-8 sm:px-6">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl md:grid-cols-2">
        <div className="flex min-h-[340px] flex-col justify-between bg-matesther-900 px-8 py-9 text-white sm:px-10 sm:py-11 md:min-h-[510px]">
          <div className="flex items-center gap-3">
            <BrandLogo className="h-12 w-12 rounded-xl" />
            <div>
              <p className="text-2xl font-extrabold tracking-wide">MATESTHER</p>
              <p className="text-xs leading-snug text-matesther-100/80">Uniform Production &amp; Business Management System</p>
            </div>
          </div>
          <div className="my-10 max-w-sm">
            <div className="mb-6 h-1 w-12 rounded-full bg-gold-400" aria-hidden="true" />
            <p className="font-serif text-2xl italic leading-relaxed text-white sm:text-[28px]">
              {MATESTHER_MOTTO}
            </p>
          </div>
          <p className="text-xs leading-relaxed text-matesther-100/70">Zone 7 behind Capital Hotel, Osogbo, Osun, Nigeria</p>
        </div>

        <div className="flex flex-col justify-center px-8 py-10 sm:px-10 md:min-h-[510px]">
          {checkingSession || (!status && !statusError) ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading Matesther...
            </div>
          ) : statusError ? (
            <div role="alert" className="space-y-4 py-10">
              <h2 className="text-lg font-semibold text-slate-900">Connection unavailable</h2>
              <p className="text-sm text-red-700">{statusError}</p>
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded-lg bg-matesther-800 px-4 py-2 text-sm font-semibold text-white hover:bg-matesther-900">Try again</button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{firstSetup ? "Create owner account" : "Sign in to Matesther"}</h1>
              {firstSetup && !status?.setupReady ? (
                <p role="alert" className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Registration is unavailable. Contact the system administrator.</p>
              ) : (
                <form onSubmit={onSubmit} className="mt-8 space-y-5">
                  {firstSetup && (
                    <label className="block text-xs font-semibold text-slate-600">Owner name
                      <div className="relative mt-1.5"><UserRound aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" /><input className={`${inputClass} pl-9`} required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
                    </label>
                  )}
                  <label className="block text-xs font-semibold text-slate-600">Email address
                    <div className="relative mt-1.5"><Mail aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" /><input className={`${inputClass} pl-9`} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
                  </label>
                  <label className="block text-xs font-semibold text-slate-600">Password
                    <div className="relative mt-1.5"><Lock aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" /><input className={`${inputClass} pl-9`} type="password" required minLength={firstSetup ? 12 : undefined} autoComplete={firstSetup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
                  </label>
                  {firstSetup && (
                    <>
                      <label className="block text-xs font-semibold text-slate-600">Confirm password<input className={`${inputClass} mt-1.5`} type="password" required autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></label>
                      <label className="block text-xs font-semibold text-slate-600">Setup key
                        <div className="relative mt-1.5"><KeyRound aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" /><input className={`${inputClass} pl-9`} type="password" required autoComplete="off" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} /></div>
                      </label>
                    </>
                  )}
                  {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
                  <button disabled={busy} type="submit" className="flex w-full items-center justify-center gap-2 rounded-lg bg-matesther-800 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-matesther-900 disabled:opacity-50">
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {busy ? "Please wait..." : firstSetup ? "Create account" : "Sign in"}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
