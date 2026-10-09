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
import { setAuthTokenGetter } from '@workspace/api-client-react';
import { ApiError, apiFetch, setToken } from './api';
import { kitchenOutbox, startKitchenReplay } from './kitchenOutbox';
import {
  clearOtherPendingIssueUploadRecovery,
  clearPendingIssueUploadRecovery,
} from './fixTrackRecovery';
import { registerForPushNotifications, unregisterPushToken } from './push';

const TOKEN_KEY = 'complytrack_mobile_token';
const TOKEN_EXPIRY_KEY = 'complytrack_mobile_token_expiry';
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
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
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const authGeneration = useRef(0);
  const activeToken = useRef<string | null>(null);

  const applyToken = useCallback((t: string | null) => {
    activeToken.current = t;
    if (t) kitchenOutbox.updateToken(t);
    else kitchenOutbox.suspend();
    setToken(t);
    setAuthTokenGetter(t ? () => t : null);
    if (!t) queryClient.clear();
  }, [queryClient]);

  useEffect(() => startKitchenReplay(async () => {
    await queryClient.invalidateQueries({ queryKey: ['food-safety'] });
  }), [queryClient]);

  useEffect(() => {
    if (user?.clientId && activeToken.current) {
      void kitchenOutbox.activate({ clientId: user.clientId, userId: user.id }, activeToken.current);
    } else {
      kitchenOutbox.suspend();
    }
    return () => kitchenOutbox.suspend();
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
          // /api/auth/me returns { user, services } or just the user object
          if (me && typeof me === 'object' && 'user' in me) {
            const full = me as MeResponse;
            if (full.requires2faSetup) {
              await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
              await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
              applyToken(null);
              setUser(null);
              setServices(null);
              return;
            }
            setUser(full.user);
            setServices(full.services ?? null);
          } else {
            setUser(me as AuthUser);
            setServices(null);
          }
          // Re-register the device for push on every authenticated app start.
          void registerForPushNotifications();
        }
      } catch (error: unknown) {
        if (authGeneration.current !== generation) return;
        // Clear only a definitively invalid session. Network/server failures
        // retain the credential so foregrounding can retry later.
        if (error instanceof ApiError && error.status === 401) {
          await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
          await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
          await clearPendingIssueUploadRecovery().catch(() => {});
          applyToken(null);
        }
      } finally {
        setIsLoading(false);
      }
    })();
  }, [applyToken, refreshSessionIfNeeded]);

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
          if (!user) {
            const me = await apiFetch<MeResponse | AuthUser>('/api/auth/me');
            if (authGeneration.current !== generation) return;
            if (me && typeof me === 'object' && 'user' in me) {
              const full = me as MeResponse;
              if (full.requires2faSetup) {
                await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
                await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
                applyToken(null);
                setUser(null);
                setServices(null);
                return;
              }
              setUser(full.user);
              setServices(full.services ?? null);
            } else {
              setUser(me as AuthUser);
              setServices(null);
            }
            void registerForPushNotifications();
          }
        } catch (error: unknown) {
          if (authGeneration.current !== generation) return;
          if (!(error instanceof ApiError) || error.status !== 401) return;
          await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
          await SecureStore.deleteItemAsync(TOKEN_EXPIRY_KEY).catch(() => {});
          applyToken(null);
          setUser(null);
          setServices(null);
        } finally {
          restoring = false;
        }
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void restore();
    });
    // An app launched without signal has no validated user yet. Recover that
    // session after reconnection without requiring another launch or a login.
    const timer = setInterval(() => {
      if (!user && AppState.currentState === 'active') void restore();
    }, 15_000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, [applyToken, refreshSessionIfNeeded, user]);

  const login = useCallback(
    async (
      email: string,
      password: string,
      pendingToken?: string,
      code?: string,
    ): Promise<{ pendingToken?: string; requires2faSetup?: boolean; setupUrl?: string }> => {
      authGeneration.current += 1;
      kitchenOutbox.suspend();
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
      await SecureStore.setItemAsync(TOKEN_KEY, ok.token);
      await SecureStore.setItemAsync(TOKEN_EXPIRY_KEY, ok.expiresAt);
      applyToken(ok.token);
      setUser(ok.user);
      // Fetch services after login via /me
      try {
        const me = await apiFetch<MeResponse | AuthUser>('/api/auth/me');
        if (me && typeof me === 'object' && 'user' in me) {
          setServices((me as MeResponse).services ?? null);
        }
      } catch {
        setServices(null);
      }
      // Register this device for push once the bearer token is active.
      void registerForPushNotifications();
      return {};
    },
    [applyToken],
  );

  const logout = useCallback(async () => {
    // Cancel any detached restore/refresh before the first asynchronous step.
    authGeneration.current += 1;
    // Isolate, rather than delete, unsent readings. Only the same verified
    // client/user can restore them; suspend before any asynchronous logout work.
    kitchenOutbox.suspend();
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
    applyToken(null);
    setUser(null);
    setServices(null);
  }, [applyToken]);

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isAuthenticated: !!user, services, hasService, login, logout }}
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
