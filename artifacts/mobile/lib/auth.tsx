import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { setAuthTokenGetter, setUnauthorizedHandler } from '@workspace/api-client-react';
import {
  ApiError,
  apiFetch,
  setToken,
  setUnauthorizedHandler as setApiUnauthorizedHandler,
} from './api';
import { kitchenOutbox, startKitchenReplay } from './kitchenOutbox';
import { checkOutbox, startCheckReplay } from './checkOutbox';
import { deliveredQueryKeys } from './checkOutboxCore';
import {
  clearOtherPendingIssueUploadRecovery,
  clearPendingIssueUploadRecovery,
} from './fixTrackRecovery';
import { registerForPushNotifications, unregisterPushToken } from './push';

const TOKEN_KEY = 'complytrack_mobile_token';
const TOKEN_EXPIRY_KEY = 'complytrack_mobile_token_expiry';
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Last validated account for the stored token: non-secret profile fields and
// enabled services only. Lets the app open offline; written and cleared
// together with the token, so it always describes the stored token's user.
const USER_CACHE_KEY = 'complytrack_mobile_user_cache';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: string;
  clientId: number | null;
}

interface MeResponse {
  user: AuthUser;
  services?: 'all' | string[] | null;
  requires2faSetup?: boolean;
}

interface MobileSessionResponse {
  token: string;
  expiresAt: string;
}

interface CachedSession {
  version: 1;
  user: AuthUser;
  services: 'all' | string[] | null;
  savedAt: string;
}

function isServices(value: unknown): value is 'all' | string[] | null {
  return value === null || value === 'all'
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

async function saveCachedSession(user: AuthUser, services: 'all' | string[] | null): Promise<void> {
  const cached: CachedSession = {
    version: 1,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      clientId: user.clientId,
    },
    services,
    savedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(cached)).catch(() => {});
}

async function loadCachedSession(): Promise<CachedSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(USER_CACHE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CachedSession>;
    const user = value?.user as Partial<AuthUser> | undefined;
    if (
      value?.version !== 1
      || !user
      || !Number.isSafeInteger(user.id)
      || typeof user.name !== 'string'
      || typeof user.email !== 'string'
      || typeof user.role !== 'string'
      || !(user.clientId === null || Number.isSafeInteger(user.clientId))
      || !isServices(value.services)
    ) return null;
    return value as CachedSession;
  } catch {
    return null;
  }
}

async function clearCachedSession(): Promise<void> {
  await SecureStore.deleteItemAsync(USER_CACHE_KEY).catch(() => {});
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Signed in from the device's saved account because the server could not
   *  be reached; re-validated automatically when the connection returns. */
  isOffline: boolean;
  services: 'all' | string[] | null;
  hasService: (key: string) => boolean;
  login: (
    email: string,
    password: string,
    pendingToken?: string,
    code?: string,
  ) => Promise<{ pendingToken?: string; requires2faSetup?: boolean; setupUrl?: string }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [services, setServices] = useState<'all' | string[] | null>(null);
  const [isOffline, setIsOfflineState] = useState(false);
  const offlineRef = useRef(false);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const authGeneration = useRef(0);
  const activeToken = useRef<string | null>(null);

  const setIsOffline = useCallback((value: boolean) => {
    offlineRef.current = value;
    setIsOfflineState(value);
  }, []);

  const applyToken = useCallback((t: string | null) => {
    activeToken.current = t;
    if (t) {
      kitchenOutbox.updateToken(t);
      checkOutbox.updateToken(t);
    } else {
      kitchenOutbox.suspend();
      checkOutbox.suspend();
    }
    setToken(t);
    setAuthTokenGetter(t ? () => t : null);
    if (!t) queryClient.clear();
  }, [queryClient]);

  // Any 401 on a request made with the signed-in bearer (apiFetch or the
  // generated client) means the session was revoked or expired: clear the
  // credentials and let the router return to the login screen. Unsent device
  // entries are isolated, not erased, exactly as on logout.
  const handleUnauthorized = useCallback(() => {
    if (!activeToken.current) return;
    authGeneration.current += 1;
    const generation = authGeneration.current;
    kitchenOutbox.suspend();
    checkOutbox.suspend();
    applyToken(null);
    setUser(null);
    setServices(null);
    setIsOffline(false);
    void (async () => {
      // Stop if a new login started meanwhile, so its token is never deleted.
      if (authGeneration.current !== generation) return;
      await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
      if (authGeneration.current !== generation) return;
      await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
      if (authGeneration.current !== generation) return;
      await clearCachedSession();
    })();
  }, [applyToken, setIsOffline]);

  useEffect(() => {
    setApiUnauthorizedHandler(handleUnauthorized);
    setUnauthorizedHandler(handleUnauthorized);
    return () => {
      setApiUnauthorizedHandler(null);
      setUnauthorizedHandler(null);
    };
  }, [handleUnauthorized]);

  useEffect(() => startKitchenReplay(async () => {
    await queryClient.invalidateQueries({ queryKey: ['food-safety'] });
  }), [queryClient]);

  useEffect(() => startCheckReplay(async (entry) => {
    await Promise.all(deliveredQueryKeys(entry.kind).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey })));
  }), [queryClient]);

  useEffect(() => {
    if (user?.clientId && activeToken.current) {
      void kitchenOutbox.activate({ clientId: user.clientId, userId: user.id }, activeToken.current);
      void checkOutbox.activate({ clientId: user.clientId, userId: user.id }, activeToken.current);
    } else {
      kitchenOutbox.suspend();
      checkOutbox.suspend();
    }
    return () => {
      kitchenOutbox.suspend();
      checkOutbox.suspend();
    };
  }, [user]);

  function hasService(key: string): boolean {
    if (services === null || services === undefined) return true;
    if (services === 'all') return true;
    return (services as string[]).includes(key);
  }

  const refreshSessionIfNeeded = useCallback(async (forceCheck = false) => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const generation = authGeneration.current;
    const operation = (async () => {
      const expiry = await SecureStore.getItemAsync(TOKEN_EXPIRY_KEY);
      const expiryMs = expiry ? Date.parse(expiry) : Number.NaN;
      if (
        !forceCheck &&
        Number.isFinite(expiryMs) &&
        expiryMs - Date.now() >= REFRESH_WINDOW_MS
      ) {
        return;
      }

      const refreshed = await apiFetch<MobileSessionResponse>(
        '/api/auth/mobile-refresh',
        { method: 'POST' },
      );
      if (authGeneration.current !== generation) {
        // Logout or a new login happened while refresh was in flight. Ensure a
        // token rotated by the server cannot survive that local auth change.
        await apiFetch('/api/auth/mobile-logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${refreshed.token}` },
        }).catch(() => {});
        return;
      }
      await SecureStore.setItemAsync(TOKEN_KEY, refreshed.token);
      await SecureStore.setItemAsync(TOKEN_EXPIRY_KEY, refreshed.expiresAt);
      applyToken(refreshed.token);
    })().finally(() => {
      refreshInFlight.current = null;
    });
    refreshInFlight.current = operation;
    return operation;
  }, [applyToken]);

  /**
   * Apply a validated /api/auth/me response. Returns false when the account
   * must set up 2FA first (credentials are then cleared).
   */
  const acceptMe = useCallback(async (me: MeResponse | AuthUser, generation: number): Promise<boolean> => {
    // /api/auth/me returns { user, services } or just the user object
    const full: MeResponse = me && typeof me === 'object' && 'user' in me
      ? me as MeResponse
      : { user: me as AuthUser, services: null };
    if (full.requires2faSetup) {
      await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
      await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
      await clearCachedSession();
      applyToken(null);
      setUser(null);
      setServices(null);
      setIsOffline(false);
      return false;
    }
    setUser(full.user);
    setServices(full.services ?? null);
    setIsOffline(false);
    if (authGeneration.current === generation) {
      await saveCachedSession(full.user, full.services ?? null);
    }
    return true;
  }, [applyToken, setIsOffline]);

  // On mount: restore token from SecureStore and validate with /api/auth/me
  useEffect(() => {
    (async () => {
      const generation = authGeneration.current;
      try {
        const stored = await SecureStore.getItemAsync(TOKEN_KEY);
        if (authGeneration.current !== generation) return;
        if (stored) {
          applyToken(stored);
          await refreshSessionIfNeeded(true);
          const me = await apiFetch<MeResponse | AuthUser>('/api/auth/me');
          if (authGeneration.current !== generation) return;
          // Re-register the device for push on every authenticated app start.
          if (await acceptMe(me, generation)) void registerForPushNotifications();
        }
      } catch (error: unknown) {
        if (authGeneration.current !== generation) return;
        // Clear only a definitively invalid session. Network/server failures
        // retain the credential so foregrounding can retry later.
        if (error instanceof ApiError && error.status === 401) {
          await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
          await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
          await clearCachedSession();
          await clearPendingIssueUploadRecovery().catch(() => {});
          applyToken(null);
        } else if (activeToken.current) {
          // No signal at launch: open with the last validated account for
          // this token so saved checks stay usable; re-validated on reconnect.
          const cached = await loadCachedSession();
          if (cached && authGeneration.current === generation && activeToken.current) {
            setUser(cached.user);
            setServices(cached.services);
            setIsOffline(true);
          }
        }
      } finally {
        setIsLoading(false);
      }
    })();
  }, [acceptMe, applyToken, refreshSessionIfNeeded, setIsOffline]);

  // Re-check the session whenever the app returns to the foreground.
  useEffect(() => {
    let restoring = false;
    const restore = async () => {
        if (restoring) return;
        restoring = true;
        const generation = authGeneration.current;
        try {
          const stored = await SecureStore.getItemAsync(TOKEN_KEY);
          if (authGeneration.current !== generation) return;
          if (!stored) return;
          applyToken(stored);
          await refreshSessionIfNeeded();
          if (!user || offlineRef.current) {
            const me = await apiFetch<MeResponse | AuthUser>('/api/auth/me');
            if (authGeneration.current !== generation) return;
            if (await acceptMe(me, generation)) void registerForPushNotifications();
          }
        } catch (error: unknown) {
          if (authGeneration.current !== generation) return;
          if (!(error instanceof ApiError) || error.status !== 401) return;
          await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
          await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
          await clearCachedSession();
          applyToken(null);
          setUser(null);
          setServices(null);
          setIsOffline(false);
        } finally {
          restoring = false;
        }
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void restore();
    });
    // An app launched without signal has no validated user yet (or only the
    // device's saved one). Recover that session after reconnection without
    // requiring another launch or a login.
    const timer = setInterval(() => {
      if ((!user || offlineRef.current) && AppState.currentState === 'active') void restore();
    }, 15_000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, [acceptMe, applyToken, refreshSessionIfNeeded, setIsOffline, user]);

  const login = useCallback(
    async (
      email: string,
      password: string,
      pendingToken?: string,
      code?: string,
    ): Promise<{ pendingToken?: string; requires2faSetup?: boolean; setupUrl?: string }> => {
      authGeneration.current += 1;
      const generation = authGeneration.current;
      kitchenOutbox.suspend();
      checkOutbox.suspend();
      const res = pendingToken
        ? await apiFetch<{ token: string; expiresAt: string; user: AuthUser }>(
            '/api/auth/mobile-login/verify-totp',
            {
              method: 'POST',
              body: JSON.stringify({ pendingToken, code }),
            },
          )
        : await apiFetch<
            | { token: string; expiresAt: string; user: AuthUser }
            | { pendingToken: string }
            | { requires2faSetup: true; setupUrl?: string }
          >('/api/auth/mobile-login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          });
      if ('pendingToken' in res) {
        return { pendingToken: res.pendingToken };
      }
      if ('requires2faSetup' in res && res.requires2faSetup) {
        return { requires2faSetup: true, setupUrl: res.setupUrl };
      }
      const ok = res as { token: string; expiresAt: string; user: AuthUser };
      // A different account must never inherit another user's recoverable
      // photo uploads on this shared device. Preserve only a recovery record
      // that demonstrably belongs to the account completing this login.
      if (ok.user.clientId !== null) {
        await clearOtherPendingIssueUploadRecovery({
          userId: ok.user.id,
          clientId: ok.user.clientId,
        }).catch(() => {});
      } else {
        await clearPendingIssueUploadRecovery().catch(() => {});
      }
      // The saved offline account always belongs to the stored token.
      await clearCachedSession();
      await SecureStore.setItemAsync(TOKEN_KEY, ok.token);
      await SecureStore.setItemAsync(TOKEN_EXPIRY_KEY, ok.expiresAt);
      applyToken(ok.token);
      setUser(ok.user);
      setIsOffline(false);
      // Fetch services after login via /me
      let loginServices: 'all' | string[] | null = null;
      try {
        const me = await apiFetch<MeResponse | AuthUser>('/api/auth/me');
        if (me && typeof me === 'object' && 'user' in me) {
          loginServices = (me as MeResponse).services ?? null;
        }
      } catch {
        loginServices = null;
      }
      setServices(loginServices);
      if (authGeneration.current === generation) {
        await saveCachedSession(ok.user, loginServices);
      }
      // Register this device for push once the bearer token is active.
      void registerForPushNotifications();
      return {};
    },
    [applyToken, setIsOffline],
  );

  const logout = useCallback(async () => {
    // Cancel any detached restore/refresh before the first asynchronous step.
    authGeneration.current += 1;
    // Isolate, rather than delete, unsent readings. Only the same verified
    // client/user can restore them; suspend before any asynchronous logout work.
    kitchenOutbox.suspend();
    checkOutbox.suspend();
    // Clear recoverable local photo references before any best-effort network
    // work, so signing out is reliable even while offline.
    await clearPendingIssueUploadRecovery().catch(() => {});
    // Unregister the device's push token while we still have a valid bearer.
    await unregisterPushToken();
    try {
      await apiFetch('/api/auth/mobile-logout', { method: 'POST' });
    } catch {
      // Best-effort
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
    await clearCachedSession();
    applyToken(null);
    setUser(null);
    setServices(null);
    setIsOffline(false);
  }, [applyToken, setIsOffline]);

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isAuthenticated: !!user, isOffline, services, hasService, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
