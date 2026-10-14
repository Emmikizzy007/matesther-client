"use client";

import Link from "next/link";
import { BrandLogo } from "@/components/BrandLogo";

/**
 * The Matesther logo as a real home link.
 *
 * `/dashboard` renders the signed-in user's own dashboard (Owner, Production
 * Manager or Worker), so one link is correct for every role. It is an ordinary
 * next/link: client-side navigation, keyboard focusable, with the accessible
 * name "Matesther Dashboard" - and it keeps working from the expanded sidebar,
 * the collapsed drawer and the mobile top bar alike.
 */
export function LogoLink({
  className = "h-10 w-10 rounded-lg",
  version,
  showWordmark = false,
}: {
  className?: string;
  version?: number;
  /** Mobile top bar shows the wordmark beside the logo inside the same link. */
  showWordmark?: boolean;
}) {
  return (
    <Link
      href="/dashboard"
      aria-label="Matesther Dashboard"
      title="Matesther Dashboard"
      className="group inline-flex min-w-0 items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-gold-400 focus-visible:ring-offset-2 focus-visible:ring-offset-matesther-900"
    >
      <BrandLogo className={className} version={version} />
      {showWordmark && (
        <span className="font-extrabold tracking-wide text-white group-hover:text-gold-400">
          MATESTHER
        </span>
      )}
    </Link>
  );
}
