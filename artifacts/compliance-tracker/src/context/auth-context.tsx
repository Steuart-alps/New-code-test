import { createContext, useContext, useEffect, useState, ReactNode, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { setClientIdGetter, setUnauthorizedHandler, setPaymentRequiredHandler } from "@workspace/api-client-react";

export type UserRole = "consultant" | "client_admin" | "client_staff" | "client_viewer";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  clientId: number | null;
  departmentId: number | null;
  active: boolean;
  totpEnabled?: boolean;
  isMaintenanceManager?: boolean;
}

export interface AuthClient {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string;
  active: boolean;
  businessType?: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  client: AuthClient | null;
  billingLocked: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ requires2fa: boolean }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  activeClientId: number | null;
  setActiveClientId: (id: number | null) => void;
  services: "all" | string[] | null;
  hasService: (key: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [client, setClient] = useState<AuthClient | null>(null);
  const [services, setServices] = useState<"all" | string[] | null>(null);
  const [billingLocked, setBillingLocked] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activeClientId, setActiveClientIdState] = useState<number | null>(null);
  const activeClientIdRef = useRef<number | null>(null);

  function setActiveClientId(id: number | null) {
    activeClientIdRef.current = id;
    setActiveClientIdState(id);
  }

  function hasService(key: string): boolean {
    if (services === null || services === undefined) return true;
    if (services === "all") return true;
    return services.includes(key);
  }

  // Wire up the API client to inject clientId into all requests
  useEffect(() => {
    setClientIdGetter(() => activeClientIdRef.current);
    return () => setClientIdGetter(null);
  }, []);

  // If any API call returns 401 the session has expired: clear auth state so
  // the router sends the user back to the login page instead of leaving stale
  // pages showing errors like "Site not found".
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setClient(null);
      setServices(null);
      setActiveClientId(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // If any API call returns 402 the client's trial has expired without a
  // subscription: flip to the billing-required screen mid-session.
  useEffect(() => {
    setPaymentRequiredHandler(() => {
      setBillingLocked(true);
    });
    return () => setPaymentRequiredHandler(null);
  }, []);

  // Auto log-out after 30 minutes of inactivity, matching the server-side
  // session expiry. The last-activity timestamp is shared across tabs via
  // localStorage so an idle background tab never logs out a user who is
  // actively working in another tab — logout fires only once EVERY tab has
  // been idle for 30 minutes. The server session (rolling 30-min expiry) is
  // the source of truth; this timer just brings idle tabs to the login page
  // promptly and best-effort destroys the by-then-idle server session.
  const lastActivityRef = useRef<number>(Date.now());
  const userRef = useRef<AuthUser | null>(null);
  userRef.current = user;
  useEffect(() => {
    const IDLE_LIMIT_MS = 30 * 60 * 1000;
    const STORAGE_KEY = "complytrack:lastActivity";
    const WRITE_THROTTLE_MS = 15_000;

    const readShared = (): number => {
      try {
        const v = Number(window.localStorage.getItem(STORAGE_KEY));
        return Number.isFinite(v) ? v : 0;
      } catch {
        return 0;
      }
    };
    let lastWrite = 0;
    const markActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      if (now - lastWrite >= WRITE_THROTTLE_MS) {
        lastWrite = now;
        try {
          window.localStorage.setItem(STORAGE_KEY, String(now));
        } catch {
          // localStorage unavailable: fall back to per-tab tracking.
        }
      }
    };
    markActivity();
    const events: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((e) => window.addEventListener(e, markActivity, { passive: true }));

    const interval = window.setInterval(() => {
      if (!userRef.current) return;
      const lastAnywhere = Math.max(lastActivityRef.current, readShared());
      if (Date.now() - lastAnywhere >= IDLE_LIMIT_MS) {
        apiFetch("/auth/logout", { method: "POST" }).catch(() => {});
        setUser(null);
        setClient(null);
        setServices(null);
        setActiveClientId(null);
      }
    }, 30_000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, markActivity));
      window.clearInterval(interval);
    };
  }, []);

  async function refresh() {
    try {
      const res = await apiFetch("/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setClient(data.client);
        setServices(data.services ?? null);
        setBillingLocked(Boolean(data.billingLocked));
        if (data.client && !activeClientId) {
          setActiveClientId(data.client.id);
        }
      } else {
        setUser(null);
        setClient(null);
        setServices(null);
      }
    } catch {
      setUser(null);
      setClient(null);
      setServices(null);
    }
  }

  useEffect(() => {
    refresh().finally(() => setIsLoading(false));
  }, []);

  async function login(email: string, password: string): Promise<{ requires2fa: boolean }> {
    const res = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? "Login failed");
    }
    const data = await res.json();
    if (data.requires2fa) return { requires2fa: true };
    setUser(data.user);
    setClient(data.client);
    setServices(data.services ?? null);
    setBillingLocked(Boolean(data.billingLocked));
    setActiveClientId(data.client?.id ?? null);
    return { requires2fa: false };
  }

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    setUser(null);
    setClient(null);
    setServices(null);
    setBillingLocked(false);
    setActiveClientId(null);
  }

  return (
    <AuthContext.Provider value={{ user, client, services, hasService, billingLocked, isLoading, login, logout, refresh, activeClientId, setActiveClientId }}>
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

export function useIsMaintenanceManager() {
  const { user } = useAuth();
  return user?.isMaintenanceManager === true;
}
