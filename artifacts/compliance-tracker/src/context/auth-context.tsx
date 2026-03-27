import { createContext, useContext, useEffect, useState, ReactNode, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { setClientIdGetter } from "@workspace/api-client-react";

export type UserRole = "consultant" | "client_admin" | "client_staff" | "client_viewer";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  clientId: number | null;
  departmentId: number | null;
  active: boolean;
}

export interface AuthClient {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string;
  active: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  client: AuthClient | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  activeClientId: number | null;
  setActiveClientId: (id: number | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [client, setClient] = useState<AuthClient | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeClientId, setActiveClientIdState] = useState<number | null>(null);
  const activeClientIdRef = useRef<number | null>(null);

  function setActiveClientId(id: number | null) {
    activeClientIdRef.current = id;
    setActiveClientIdState(id);
  }

  // Wire up the API client to inject clientId into all requests
  useEffect(() => {
    setClientIdGetter(() => activeClientIdRef.current);
    return () => setClientIdGetter(null);
  }, []);

  async function refresh() {
    try {
      const res = await apiFetch("/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setClient(data.client);
        if (data.client && !activeClientId) {
          setActiveClientId(data.client.id);
        }
      } else {
        setUser(null);
        setClient(null);
      }
    } catch {
      setUser(null);
      setClient(null);
    }
  }

  useEffect(() => {
    refresh().finally(() => setIsLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? "Login failed");
    }
    const data = await res.json();
    setUser(data.user);
    setClient(data.client);
    setActiveClientId(data.client?.id ?? null);
  }

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    setUser(null);
    setClient(null);
    setActiveClientId(null);
  }

  return (
    <AuthContext.Provider value={{ user, client, isLoading, login, logout, refresh, activeClientId, setActiveClientId }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function useCanEdit() {
  const { user } = useAuth();
  if (!user) return false;
  return user.role === "consultant" || user.role === "client_admin" || user.role === "client_staff";
}

export function useCanAdmin() {
  const { user } = useAuth();
  if (!user) return false;
  return user.role === "consultant" || user.role === "client_admin";
}

export function useIsConsultant() {
  const { user } = useAuth();
  return user?.role === "consultant";
}
