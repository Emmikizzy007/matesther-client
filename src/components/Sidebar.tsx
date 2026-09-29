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
} from "lucide-react";
import { useState } from "react";
import { useAuth, roleLabel, Role } from "@/lib/auth";
import { BrandLogo } from "@/components/BrandLogo";

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
      { href: "/production/inspection", label: "Inspection Queue", icon: ClipboardCheck },
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
      { href: "/production", label: "Active Production", icon: Factory },
      { href: "/production/inspection", label: "Inspection Queue", icon: ClipboardCheck },
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
];

const WORKER_NAV: NavGroup[] = [
  {
    label: "My Work",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: Briefcase },
      { href: "/worker/jobs", label: "My Jobs", icon: Factory },
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
    <div className="flex items-center gap-3 px-5 py-5">
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

  const groups = navForRole(user?.role ?? "WORKER");

  const list = (
    <nav className="px-3 pb-4 space-y-4">
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
    <div className="px-5 py-4 border-t border-white/10">
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
      <div className="lg:hidden flex items-center justify-between bg-matesther-900 px-4 py-3 sticky top-0 z-40">
        <div className="flex items-center gap-2">
          <BrandLogo className="h-8 w-8 rounded-lg" />
          <span className="font-extrabold text-white tracking-wide">MATESTHER</span>
        </div>
        <button
          onClick={() => setOpen(!open)}
          className="text-white p-1"
          aria-label="Toggle menu"
        >
          {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-slate-950/60" onClick={() => setOpen(false)} />
          <div className="relative w-72 h-full bg-matesther-900 flex flex-col">
            <Brand />
            <div className="flex-1 min-h-0 overflow-y-auto slim-scroll">
              {list}
            </div>
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
