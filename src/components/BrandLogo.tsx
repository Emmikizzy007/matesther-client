"use client";

import { useState } from "react";

/** Shows the Owner's original uploaded logo, with a clean text mark until it loads. */
export function BrandLogo({ className = "h-10 w-10", version }: { className?: string; version?: number }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className={`${className} relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gold-400`}>
      {!loaded && <span aria-hidden="true" className="text-lg font-extrabold text-matesther-950">M</span>}
      <img
        src={version ? `/api/branding/logo?v=${version}` : "/api/branding/logo"}
        alt="Matesther company logo"
        className={`absolute inset-0 h-full w-full object-contain ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
      />
    </span>
  );
}
