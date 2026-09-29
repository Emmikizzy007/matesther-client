"use client";

import type { ReactNode } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { MATESTHER_MOTTO } from "@/lib/brand";

export interface LetterBusiness {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export function Letterhead({
  business,
  ourRef,
  yourRef,
  date,
  title,
  subtitle,
  children,
}: {
  business?: LetterBusiness | null;
  ourRef: string;
  yourRef: string;
  date: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <article className="matesther-letter bg-white text-[#242527]" aria-label={`${title}, ${ourRef}`}>
      <header className="letter-header">
        <div className="letter-logo-wrap"><BrandLogo className="h-[60px] w-[60px] rounded-sm" /></div>
        <h1 className="letter-brand">Matesther Enterprises</h1>
        <p className="letter-tagline">perfecting the right stitches</p>
        <div className="letter-contact">
          {business?.address && <p>{business.address}</p>}
          <p>
            {business?.phone && <span>Tel: {business.phone}</span>}
            {business?.phone && business?.email && <span className="mx-2 text-[#a86b42]">|</span>}
            {business?.email && <span>Email: {business.email}</span>}
          </p>
        </div>
        <div className="letter-color-rule" aria-hidden="true"><span /><span /></div>
        <div className="letter-references">
          <p><strong>Our ref:</strong> <span>{ourRef}</span></p>
          <p><strong>Your ref:</strong> <span>{yourRef}</span></p>
          <p><strong>Date:</strong> <span>{date}</span></p>
        </div>
      </header>
      <div className="letter-body">
        <div className="letter-heading">
          <p className="letter-kicker">MATESTHER UNIFORMS</p>
          <h2>{title}</h2>
          {subtitle && <p className="letter-subtitle">{subtitle}</p>}
        </div>
        {children}
      </div>
      <footer className="letter-footer">
        <div className="letter-color-rule" aria-hidden="true"><span /><span /></div>
        <div className="letter-footer-row">
          <BrandLogo className="h-9 w-9 rounded-sm" />
          <span>{MATESTHER_MOTTO}</span>
        </div>
      </footer>
    </article>
  );
}
