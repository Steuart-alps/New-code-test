import { createContext, useContext, useEffect, useState, ReactNode, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  apiFetch,
  clearCsrfToken,
  setApiFetchClientIdGetter,
  setApiFetchMutationObserver,
  setApiFetchPaymentRequiredHandler,
  setApiFetchUnauthorizedHandler,
} from "@/lib/api";
import { setClientIdGetter, setUnauthorizedHandler, setPaymentRequiredHandler, setMutationObserver } from "@workspace/api-client-react";
import { createCompletedWorkObserver } from "@/lib/analytics";

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
  isDepartmentManager?: boolean;
}

export type PasskeyOptions = Record<string, unknown>;

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
  login: (email: string, password: string) => Promise<{ requires2fa: boolean; requiresPasskey?: boolean; passkeyOptions?: PasskeyOptions; requires2faSetup?: boolean; requiresEmailVerification?: boolean }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  activeClientId: number | null;
  setActiveClientId: (id: number | null) => void;
  services: "all" | string[] | null;
  needsTwoFactorSetup: boolean;
  /** False when every business this user belongs to has made 2FA optional. */
  twoFactorRequired: boolean;
  hasService: (key: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// A consultant's selected business survives reloads in this tab. It is only a
// hint: on load it is re-checked against the businesses the server lets this
// user open, and the server re-authorises every request anyway.
const ACTIVE_CLIENT_KEY = "complytrack:activeClient";

function readStoredActiveClient(userId: number): number | null {
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_CLIENT_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { userId?: unknown; clientId?: unknown };
    return stored.userId === userId && Number.isInteger(stored.clientId) ? stored.clientId as number : null;
  } catch {
    return null;
  }
}

function writeStoredActiveClient(userId: number | null, clientId: number | null): void {
  try {
    if (userId === null || clientId === null) window.sessionStorage.removeItem(ACTIVE_CLIENT_KEY);
    else window.sessionStorage.setItem(ACTIVE_CLIENT_KEY, JSON.stringify({ userId, clientId }));
  } catch {
    // Storage unavailable: the selection just won't survive a reload.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [client, setClient] = useState<AuthClient | null>(null);
  const [services, setServices] = useState<"all" | string[] | null>(null);
  const [needsTwoFactorSetup, setNeedsTwoFactorSetup] = useState(false);
  const [twoFactorRequired, setTwoFactorRequired] = useState(true);
  const [billingLocked, setBillingLocked] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activeClientId, setActiveClientIdState] = useState<number | null>(null);
  const activeClientIdRef = useRef<number | null>(null);
  const userRef = useRef<AuthUser | null>(null);
  userRef.current = user;
  const queryClient = useQueryClient();

  // Cached queries are keyed without the business, so they must never outlive
  // the session or business they were loaded for.
  function setActiveClientId(id: number | null) {
    const previous = activeClientIdRef.current;
    activeClientIdRef.current = id;
    setActiveClientIdState(id);
    if (previous !== id) {
      // Reset (not just remove) so pages already on screen refetch for the
      // new business instead of keeping the previous one's rows.
      void queryClient.resetQueries().catch(() => {});
    }
    const current = userRef.current;
    if (current?.role === "consultant") writeStoredActiveClient(current.id, id);
  }

  /** Signs the tab out locally and forgets everything loaded for that user. */
  function clearSession() {
    userRef.current = null;
    setUser(null);
    setClient(null);
    setServices(null);
    activeClientIdRef.current = null;
    setActiveClientIdState(null);
    writeStoredActiveClient(null, null);
    void queryClient.cancelQueries().catch(() => {});
    queryClient.clear();
  }

  function hasService(key: string): boolean {
    if (services === null || services === undefined) return true;
    if (services === "all") return true;
    return services.includes(key);
  }

  // Wire up the API client to inject clientId into all requests
  useEffect(() => {
    const getter = () => activeClientIdRef.current;
    setClientIdGetter(getter);
    setApiFetchClientIdGetter(getter);
    return () => {
      setClientIdGetter(null);
      setApiFetchClientIdGetter(null);
    };
  }, []);

  // Record the first saved compliance record or completed check after a paid
  // activation (trackModuleWorkCompleted). Route visits stay in
  // module_first_used; this measures practical adoption.
  useEffect(() => {
    const observer = createCompletedWorkObserver(() => activeClientIdRef.current);
    setMutationObserver(observer);
    setApiFetchMutationObserver(observer);
    return () => {
      setMutationObserver(null);
      setApiFetchMutationObserver(null);
    };
  }, []);

  // If any API call returns 401 the session has expired: clear auth state so
  // the router sends the user back to the login page instead of leaving stale
  // pages showing errors like "Site not found".
  useEffect(() => {
    const onUnauthorized = () => clearSession();
    setUnauthorizedHandler(onUnauthorized);
    setApiFetchUnauthorizedHandler(onUnauthorized);
    return () => {
      setUnauthorizedHandler(null);
      setApiFetchUnauthorizedHandler(null);
    };
  }, []);

  // If any API call returns 402 the client's trial has expired without a
  // subscription: flip to the billing-required screen mid-session.
  useEffect(() => {
    const onPaymentRequired = () => setBillingLocked(true);
    setPaymentRequiredHandler(onPaymentRequired);
    setApiFetchPaymentRequiredHandler(onPaymentRequired);
    return () => {
      setPaymentRequiredHandler(null);
      setApiFetchPaymentRequiredHandler(null);
    };
  }, []);

  // Auto log-out after 30 minutes of inactivity, matching the server-side
  // session expiry. The last-activity timestamp is shared across tabs via
  // localStorage so an idle background tab never logs out a user who is
  // actively working in another tab — logout fires only once EVERY tab has
  // been idle for 30 minutes. The server session (rolling 30-min expiry) is
  // the source of truth; this timer just brings idle tabs to the login page
  // promptly and best-effort destroys the by-then-idle server session.
  const lastActivityRef = useRef<number>(Date.now());
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
        apiFetch("/auth/logout", { method: "POST" }).catch(() => {}).finally(clearCsrfToken);
        clearSession();
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
        setNeedsTwoFactorSetup(Boolean(data.requires2faSetup));
        setTwoFactorRequired(data.twoFactorRequired !== false);
        setBillingLocked(Boolean(data.billingLocked));
        userRef.current = data.user;
        if (activeClientIdRef.current === null) {
          const restored = data.user?.role === "consultant"
            ? await restoreActiveClient(data.user.id, data.client?.id ?? null)
            : null;
          const initial = restored ?? data.client?.id ?? null;
          if (initial !== null) setActiveClientId(initial);
        }
      } else {
        clearSession();
        setNeedsTwoFactorSetup(false);
      }
    } catch {
      clearSession();
      setNeedsTwoFactorSetup(false);
    }
  }

  /** The consultant's remembered business, if they may still open it. */
  async function restoreActiveClient(userId: number, homeClientId: number | null): Promise<number | null> {
    const stored = readStoredActiveClient(userId);
    if (stored === null || stored === homeClientId) return null;
    try {
      const res = await apiFetch(`/clients/${stored}`);
      if (res.ok) return stored;
    } catch {
      // Fall through to the home business.
    }
    writeStoredActiveClient(null, null);
    return null;
  }

  useEffect(() => {
    refresh().finally(() => setIsLoading(false));
  }, []);

  async function login(email: string, password: string): Promise<{ requires2fa: boolean; requiresPasskey?: boolean; passkeyOptions?: PasskeyOptions; requires2faSetup?: boolean; requiresEmailVerification?: boolean }> {
    const res = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const error = new Error(data.error ?? "Login failed") as Error & { requiresEmailVerification?: boolean };
      error.requiresEmailVerification = data.requiresEmailVerification;
      throw error;
    }
    const data = await res.json();
    if (data.requires2fa || data.requiresPasskey) {
      return { requires2fa: Boolean(data.requires2fa), requiresPasskey: Boolean(data.requiresPasskey), passkeyOptions: data.passkeyOptions };
    }
    if (data.requires2faSetup) {
      setNeedsTwoFactorSetup(true);
      return { requires2fa: false, requires2faSetup: true };
    }
    // Another account may have used this tab: start from an empty cache.
    queryClient.clear();
    userRef.current = data.user;
    setUser(data.user);
    setClient(data.client);
    setServices(data.services ?? null);
    setBillingLocked(Boolean(data.billingLocked));
    setActiveClientId(data.client?.id ?? null);
    setNeedsTwoFactorSetup(false);
    setTwoFactorRequired(data.twoFactorRequired !== false);
    return { requires2fa: false };
  }

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    // The session (and its CSRF token) is gone; the next sign-in gets a new one.
    clearCsrfToken();
    clearSession();
    setBillingLocked(false);
    setNeedsTwoFactorSetup(false);
  }

  return (
    <AuthContext.Provider value={{ user, client, services, hasService, billingLocked, isLoading, login, logout, refresh, activeClientId, setActiveClientId, needsTwoFactorSetup, twoFactorRequired }}>
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
