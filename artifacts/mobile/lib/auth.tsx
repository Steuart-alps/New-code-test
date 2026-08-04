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

const TOKEN_KEY = 'complytrack_mobile_token';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: string;
  clientId: number | null;
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const applyToken = useCallback((t: string | null) => {
    setToken(t);
    setAuthTokenGetter(t ? () => t : null);
  }, []);

  // On mount: restore token from SecureStore and validate with /api/auth/me
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(TOKEN_KEY);
        if (stored) {
          applyToken(stored);
          const me = await apiFetch<AuthUser>('/api/auth/me');
          setUser(me);
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
    async (email: string, password: string) => {
      const res = await apiFetch<{ token: string; user: AuthUser }>(
        '/api/auth/mobile-login',
        {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        },
      );
      await SecureStore.setItemAsync(TOKEN_KEY, res.token);
      applyToken(res.token);
      setUser(res.user);
    },
    [applyToken],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/mobile-logout', { method: 'POST' });
    } catch {
      // Best-effort
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    applyToken(null);
    setUser(null);
  }, [applyToken]);

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isAuthenticated: !!user, login, logout }}
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
