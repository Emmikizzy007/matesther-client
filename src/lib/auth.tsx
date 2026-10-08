"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export type Role = "OWNER" | "PRODUCTION_MANAGER" | "WORKER";
export interface SessionUser {
  name: string;
  email: string;
  role: Role;
  /**
   * The caller's OWN factory profile, resolved server-side, or null when they have
   * none. Present so a screen can tell a tailor holding production from a helper
   * without asking for a staff-only list - both are the WORKER role.
   *
   * Optional because the login response does not carry it; only /api/auth/me does.
   * Nothing decided from it is trusted: every action it enables is re-authorised on
   * the server, so a forged value in a browser buys nothing.
   */
  workerId?: number | null;
  workerName?: string | null;
}

type AuthContextType = {
  user: SessionUser | null;
  loginWithPassword: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  loading: boolean;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  loginWithPassword: async () => { throw new Error("Sign-in is not ready"); },
  logout: async () => {},
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    // Do not trust a previously stored browser role. Always ask the server.
    fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => response.ok ? (await response.json()) as SessionUser : null)
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const loginWithPassword = useCallback(async (email: string, password: string) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Sign-in failed. Please try again.");
    const account: SessionUser = {
      name: result.name,
      email: result.email,
      role: result.role,
      // The login response carries the same factory profile /api/auth/me resolves, so a
      // tailor's hand-out action is correct from the first screen after signing in, with
      // no reload. Every action it enables is still re-authorised by the server.
      workerId: result.workerId ?? null,
      workerName: result.workerName ?? null,
    };
    setUser(account);
    router.replace("/dashboard");
    router.refresh();
    return account;
  }, [router]);

  const logout = useCallback(async () => {
    const response = await fetch("/api/auth/logout", {
      method: "POST", credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Could not sign out. Check your connection and try again.");
    setUser(null);
    router.replace("/login");
    router.refresh();
  }, [router]);

  return <AuthContext.Provider value={{ user, loginWithPassword, logout, loading }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

export function roleLabel(role: Role): string {
  return role === "OWNER" ? "Owner / Admin" : role === "PRODUCTION_MANAGER" ? "Project Manager" : "Worker";
}

export function allowedPaths(role: Role): string[] {
  if (role === "OWNER") return ["*"];
  if (role === "PRODUCTION_MANAGER") return ["/dashboard", "/production", "/workers", "/worker"];
  // A Worker may also reach Support Work: a tailor's helper submits and reviews
  // the support work handed to them. The API returns only their own records.
  return ["/dashboard", "/worker", "/production/support"];
}

export function canAccess(role: Role, path: string): boolean {
  const allowed = allowedPaths(role);
  return allowed.includes("*") || allowed.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}
