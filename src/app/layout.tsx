import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Matesther ERP - Uniform Production & Business Management System",
  description: "Matesther uniforms: orders, cutting, production, inspection, delivery and costs.",
  applicationName: "Matesther ERP",
  icons: {
    icon: "/api/branding/logo?size=48",
    apple: "/api/branding/logo?size=180",
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Matesther" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0a3520",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#f1f4f1] text-slate-900 antialiased">
        <AuthProvider>{children}</AuthProvider>
        <script dangerouslySetInnerHTML={{
          __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}`,
        }} />
      </body>
    </html>
  );
}
