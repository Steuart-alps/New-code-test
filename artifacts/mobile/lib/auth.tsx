import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import { setAuthTokenGetter } from '@workspace/api-client-react';
import { apiFetch, setToken } from './api';
import { registerForPushNotifications, unregisterPushToken } from './push';

const TOKEN_KEY = 'complytrack_mobile_token';

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
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  services: 'all' | string[] | null;
  hasService: (key: string) => boolean;
  login: (email: string, password: string, code?: string) => Promise<{ requires2fa: boolean }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [services, setServices] = useState<'all' | string[] | null>(null);

  const applyToken = useCallback((t: string | null) => {
    setToken(t);
    setAuthTokenGetter(t ? () => t : null);
  }, []);

  function hasService(key: string): boolean {
    if (services === null || services === undefined) return true;
    if (services === 'all') return true;
    return (services as string[]).includes(key);
  }

  // On mount: restore token from SecureStore and validate with /api/auth/me
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(TOKEN_KEY);
        if (stored) {
          applyToken(stored);
          const me = await apiFetch<MeResponse | AuthUser>('/api/auth/me');
          // /api/auth/me returns { user, services } or just the user object
          if (me && typeof me === 'object' && 'user' in me) {
            const full = me as MeResponse;
            setUser(full.user);
            setServices(full.services ?? null);
          } else {
            setUser(me as AuthUser);
            setServices(null);
          }
          // Re-register the device for push on every authenticated app start.
          void registerForPushNotifications();
        }
      } catch {
        // Stale or invalid token — clear it
        await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
        applyToken(null);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [applyToken]);

  const login = useCallback(
    async (email: string, password: string, code?: string): Promise<{ requires2fa: boolean }> => {
      const res = await apiFetch<
        { token: string; user: AuthUser } | { requires2fa: true }
      >('/api/auth/mobile-login', {
        method: 'POST',
        body: JSON.stringify(code ? { email, password, code } : { email, password }),
      });
      if ('requires2fa' in res && res.requires2fa) {
        return { requires2fa: true };
      }
      const ok = res as { token: string; user: AuthUser };
      await SecureStore.setItemAsync(TOKEN_KEY, ok.token);
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
      return { requires2fa: false };
    },
    [applyToken],
  );

  const logout = useCallback(async () => {
    // Unregister the device's push token while we still have a valid bearer.
    await unregisterPushToken();
    try {
      await apiFetch('/api/auth/mobile-logout', { method: 'POST' });
    } catch {
      // Best-effort
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
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
