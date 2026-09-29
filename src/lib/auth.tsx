"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export type Role = "OWNER" | "PRODUCTION_MANAGER" | "WORKER";
export interface SessionUser {
  name: string;
  email: string;
  role: Role;
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
  return ["/dashboard", "/worker"];
}

export function canAccess(role: Role, path: string): boolean {
  const allowed = allowedPaths(role);
  return allowed.includes("*") || allowed.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}
