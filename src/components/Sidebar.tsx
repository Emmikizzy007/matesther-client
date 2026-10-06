"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ShoppingBag,
  Users,
  Tags,
  Factory,
  ClipboardCheck,
  History,
  ContactRound,
  UserCheck,
  Boxes,
  Truck,
  PackageCheck,
  Route,
  Wallet,
  CreditCard,
  TrendingUp,
  HandCoins,
  BarChart3,
  UserCog,
  Settings,
  Briefcase,
  BookOpen,
  Coins,
  User,
  LogOut,
  Menu,
  X,
  HandHelping,
  Gauge,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth, roleLabel, Role } from "@/lib/auth";
import { BrandLogo } from "@/components/BrandLogo";
import { InstallPrompt } from "@/components/InstallPrompt";

type NavItem = { href: string; label: string; icon: any };
type NavGroup = { label: string; items: NavItem[] };

const OWNER_NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Business",
    items: [
      { href: "/orders", label: "Orders", icon: ShoppingBag },
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/products", label: "Products", icon: Tags },
    ],
  },
  {
    label: "Production",
    items: [
      { href: "/production", label: "Active Production", icon: Factory },
      { href: "/production/control", label: "Production Control", icon: Gauge },
      { href: "/production/assign", label: "Assign Production", icon: UserCheck },
      { href: "/production/support", label: "Support Work", icon: HandHelping },
      { href: "/production/inspection", label: "Inspection Queue", icon: ClipboardCheck },
      { href: "/production/external", label: "External & Ready-made", icon: PackageCheck },
      { href: "/production/routes", label: "Production Routes", icon: Route },
      { href: "/production/history", label: "Production History", icon: History },
      { href: "/workers", label: "Workers", icon: ContactRound },
    ],
  },
  {
    label: "Inventory",
    items: [
      { href: "/materials", label: "Materials", icon: Boxes },
      { href: "/materials/purchases", label: "Material Purchases", icon: Truck },
      { href: "/materials/usage", label: "Material Usage", icon: PackageCheck },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/expenses", label: "Expenses", icon: Wallet },
      { href: "/payments", label: "Payments", icon: CreditCard },
      { href: "/payroll", label: "Worker Payments", icon: HandCoins },
      { href: "/profitability", label: "Profitability", icon: TrendingUp },
    ],
  },
  {
    label: "Reports",
    items: [{ href: "/reports", label: "Reports", icon: BarChart3 }],
  },
  {
    label: "Administration",
    items: [
      { href: "/users", label: "Users", icon: UserCog },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const PM_NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ href: "/dashboard", label: "Production Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Production",
    items: [
      { href: "/production/assign", label: "Assign Production", icon: UserCheck },
      { href: "/production", label: "Active Production", icon: Factory },
      { href: "/production/control", label: "Production Control", icon: Gauge },
      { href: "/production/support", label: "Support Work", icon: HandHelping },
      { href: "/production/inspection", label: "Inspection Queue", icon: ClipboardCheck },
      { href: "/production/external", label: "External & Ready-made", icon: PackageCheck },
      { href: "/production/routes", label: "Production Routes", icon: Route },
      { href: "/production/history", label: "Production History", icon: History },
    ],
  },
  {
    label: "Workers",
    items: [
      { href: "/workers", label: "Workers", icon: ContactRound },
      { href: "/workers/assignments", label: "Worker Assignments", icon: UserCheck },
    ],
  },
  {
    label: "My Factory Work",
    items: [
      { href: "/worker/jobs", label: "My Jobs", icon: Briefcase },
      { href: "/worker/journal", label: "My Journal", icon: BookOpen },
      { href: "/worker/earnings", label: "My Earnings", icon: Coins },
      { href: "/worker/profile", label: "My Profile", icon: User },
    ],
  },
];

const WORKER_NAV: NavGroup[] = [
  {
    label: "My Work",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: Briefcase },
      { href: "/worker/jobs", label: "My Jobs", icon: Factory },
      { href: "/production/support", label: "Support Work", icon: HandHelping },
      { href: "/worker/journal", label: "My Journal", icon: BookOpen },
      { href: "/worker/earnings", label: "My Earnings", icon: Coins },
      { href: "/worker/profile", label: "Profile", icon: User },
    ],
  },
];

function navForRole(role: Role): NavGroup[] {
  if (role === "OWNER") return OWNER_NAV;
  if (role === "PRODUCTION_MANAGER") return PM_NAV;
  return WORKER_NAV;
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <BrandLogo className="h-10 w-10 rounded-lg" />
      <div>
        <p className="font-extrabold tracking-wide text-white text-lg leading-none">MATESTHER</p>
        <p className="text-[10px] text-matesther-100/80 mt-1 leading-tight">
          Uniform Production &amp; Business Management
        </p>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  /**
   * What needs attention, pulled once when the signed-in role is known.
   *
   * This is the visible half of GET /api/attention. It is deliberately a pull and deliberately
   * not polled: the alerts are derived from the production ledger on every request, so a
   * background timer would repeat an expensive derivation on every open tab for a figure that
   * only has to be right when somebody looks. One read per page load, no retries, and a
   * failure that cannot break the navigation - an alert bar that will not load is an
   * inconvenience, a sidebar that will not render is not.
   */
  const [attention, setAttention] = useState<{
    total: number;
    top: { count: number; unit: string; title: string } | null;
  } | null>(null);
  const role = user?.role;
  useEffect(() => {
    // Staff only. The endpoint refuses a Worker, and a Worker's own view of their work is the
    // worker dashboard, which already scopes to their allocations - so not sending the request
    // at all keeps a pointless 403 off the network and an expensive derivation off a screen
    // that could never show it.
    if (!role || role === ("WORKER" as Role)) return;
    let cancelled = false;
    fetch("/api/attention", { cache: "no-store", headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data.total !== "number") return;
        const top = Array.isArray(data.alerts) && data.alerts.length ? data.alerts[0] : null;
        setAttention({ total: data.total, top });
      })
      .catch(() => { /* nothing to show; the navigation is what matters */ });
    return () => { cancelled = true; };
  }, [role]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", onKey); };
  }, [open]);

  const groups = navForRole(user?.role ?? "WORKER");

  const list = (
    <nav className="px-3 pb-4 space-y-4">
      {attention !== null && attention.total > 0 && (
        <Link
          href="/production/control"
          className="mx-3 mb-3 flex items-start gap-2 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[11px] leading-snug text-amber-50"
        >
          <span className="mt-px inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-300 px-1 text-[10px] font-extrabold text-[#282b25]">
            {attention.total}
          </span>
          <span>
            {attention.top
              ? `${attention.top.count} ${attention.top.unit} — ${attention.top.title}`
              : "Needs attention"}
          </span>
        </Link>
      )}
      {groups.map((g) => (
        <div key={g.label}>
          <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-matesther-100/50">
            {g.label}
          </p>
          <div className="space-y-1">
            {g.items.map((n) => {
              const active =
                pathname === n.href || pathname.startsWith(n.href + "/");
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? "bg-gold-500 text-matesther-950"
                      : "text-matesther-100/85 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <Icon className="w-[18px] h-[18px] shrink-0" />
                  {n.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  const userBox = (
    <div className="px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-white/10">
      <InstallPrompt />
      <p className="text-sm font-semibold text-white truncate">
        {user?.name ?? "Matesther User"}
      </p>
      <p className="text-xs text-matesther-100/70">
        {user ? roleLabel(user.role) : ""}
      </p>
      <button
        onClick={() => logout().catch((error) => alert(error instanceof Error ? error.message : "Please try signing out again."))}
        className="mt-3 flex items-center gap-2 text-xs font-medium text-matesther-100/80 hover:text-white"
      >
        <LogOut className="w-4 h-4" /> Sign out
      </button>
    </div>
  );

  return (
    <>
      {/* mobile top bar */}
      <div className="lg:hidden flex items-center justify-between bg-matesther-900 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sticky top-0 z-40">
        <div className="flex items-center gap-2">
          <BrandLogo className="h-8 w-8 rounded-lg" />
          <span className="font-extrabold text-white tracking-wide">MATESTHER</span>
        </div>
        <button
          onClick={() => setOpen(!open)}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-white hover:bg-white/10"
          aria-label="Toggle menu"
          aria-expanded={open}
        >
          {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-slate-950/60" onClick={() => setOpen(false)} />
          <div className="relative flex h-[100dvh] w-[min(88vw,320px)] flex-col bg-matesther-900 shadow-2xl" role="dialog" aria-modal="true" aria-label="Matesther navigation">
            <div className="flex items-center justify-between border-b border-white/10 pr-3">
              <Brand />
              <button type="button" onClick={() => setOpen(false)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white hover:bg-white/10" aria-label="Close navigation"><X className="h-5 w-5" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain slim-scroll">{list}</div>
            {userBox}
          </div>
        </div>
      )}

      {/* desktop sidebar */}
      <aside className="hidden lg:flex w-64 shrink-0 bg-matesther-900 min-h-screen flex-col fixed inset-y-0 left-0 z-30">
        <Brand />
        <div className="flex-1 min-h-0 overflow-y-auto slim-scroll">
          {list}
        </div>
        {userBox}
      </aside>
    </>
  );
}
