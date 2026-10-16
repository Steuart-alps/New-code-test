import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isConnectionError } from '@/components/outbox-status-logic';
import {
  chooseRegisterData,
  parseRegisterCache,
  registerCacheKey,
  serializeRegisterCache,
  type CachedRegister,
  type RegisterName,
} from '@/components/registers-logic';

/**
 * A read-only register list with an offline copy: each successful load is
 * saved on the phone for this client and user, and shown (with when it was
 * last updated) while loading or when there is no connection. Saved copies
 * are cleared on sign-out (lib/registerCache.ts).
 */
export function useCachedRegister<T>(name: RegisterName, queryKey: readonly unknown[], path: string, enabled = true) {
  const { user } = useAuth();
  const identity = user?.clientId ? { clientId: user.clientId, userId: user.id } : null;
  const storageKey = identity ? registerCacheKey(identity, name) : null;
  const [cached, setCached] = useState<CachedRegister<T> | null>(null);

  useEffect(() => {
    let active = true;
    setCached(null);
    if (!storageKey || !enabled) return;
    AsyncStorage.getItem(storageKey)
      .then((raw) => { if (active) setCached(parseRegisterCache<T>(raw)); })
      .catch(() => {});
    return () => { active = false; };
  }, [storageKey, enabled]);

  const query = useQuery<T[]>({
    queryKey,
    enabled: enabled && !!storageKey,
    queryFn: async () => {
      const data = await apiFetch<T[]>(path);
      const rows = Array.isArray(data) ? data : [];
      if (storageKey) await AsyncStorage.setItem(storageKey, serializeRegisterCache(rows, new Date())).catch(() => {});
      return rows;
    },
  });

  const shown = chooseRegisterData<T>({
    live: query.data,
    cached,
    errored: query.isError,
    connectionError: query.isError && isConnectionError(query.error),
  });
  return { ...shown, query };
}
