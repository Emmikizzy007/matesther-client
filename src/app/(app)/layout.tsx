"use client";

import { ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { useAuth, canAccess } from "@/lib/auth";
import { Loader2 } from "lucide-react";

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
    else if (!loading && user && !canAccess(user.role, pathname))
      router.replace("/dashboard");
  }, [loading, user, pathname, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading Matesther…
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="lg:pl-64">
        <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">{children}</div>
      </main>
    </div>
  );
}
