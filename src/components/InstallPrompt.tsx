"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

/**
 * Offers the browser's own "Add to Home Screen" install prompt.
 *
 * PROJECT_CONTEXT.md section 33 lists installable app behaviour and Android/iOS
 * "Add to Home Screen" as requirements. The manifest and service worker already
 * make the app installable through the browser menu; this surfaces the same
 * browser-owned prompt in the app itself.
 *
 * It renders nothing until the browser fires `beforeinstallprompt`, so it stays
 * invisible on iOS Safari and on any browser that does not offer the event.
 * Nothing is faked: the real browser prompt is shown, so the platform's own
 * install rules and user consent still apply.
 */
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Stop the browser showing its own banner at a moment of its choosing;
      // we re-present the identical prompt from the sidebar instead.
      event.preventDefault();
      setDeferred(event as InstallEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Not offered yet, already installed, or unsupported: take no space at all.
  if (installed || !deferred) return null;

  return (
    <button
      type="button"
      onClick={() => {
        void deferred.prompt().then(() => setDeferred(null));
      }}
      className="mb-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 text-xs font-semibold text-matesther-100 transition-colors hover:bg-white/10"
    >
      <Download className="h-4 w-4 shrink-0" /> Install Matesther app
    </button>
  );
}
