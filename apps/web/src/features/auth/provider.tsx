"use client";

// ============================================
// DENGARKAN — Auth Feature: Context Provider
// ============================================

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { AuthUser } from "@dengarkan/shared";
import { apiClient } from "@/services/api-client";

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // If running in browser on HTTP on a public domain, upgrade to HTTPS immediately
    if (
      typeof window !== "undefined" &&
      window.location.protocol === "http:" &&
      !window.location.hostname.includes("localhost") &&
      !/^(\d{1,3}\.){3}\d{1,3}$/.test(window.location.hostname)
    ) {
      window.location.replace(
        "https://" +
          window.location.host +
          window.location.pathname +
          window.location.search +
          window.location.hash
      );
      return;
    }

    apiClient.auth
      .session()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));
  }, []);


  const login = useCallback(async (username: string, password: string) => {
    const res = await apiClient.auth.login(username, password);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    setUser(null);
    try {
      await apiClient.auth.logout();
    } catch {
      // Non-fatal: ensure user is logged out locally even if network is offline
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
