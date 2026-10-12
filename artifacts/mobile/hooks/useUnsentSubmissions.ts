import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@/lib/auth';
import {
  discardUnsent,
  parseUnsentSubmissions,
  recordUnsent,
  resolveUnsent,
  unsentSubmissionKey,
  type UnsentSubmission,
} from '@/components/unsent-submission-logic';

const newDraftId = () =>
  `unsent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Device copies of failed submissions for one form (see
 * unsent-submission-logic.ts). `record` on a failed submit, `resolve` on a
 * successful one, `discard` when the user drops a copy.
 */
export function useUnsentSubmissions(formKey: string) {
  const { user } = useAuth();
  const key = user && user.clientId !== null
    ? unsentSubmissionKey({ clientId: user.clientId, userId: user.id }, formKey)
    : null;
  const [state, setState] = useState<{ key: string | null; drafts: UnsentSubmission[] }>({ key: null, drafts: [] });
  const lock = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    setState({ key, drafts: [] });
    if (!key) return;
    AsyncStorage.getItem(key)
      .then((raw) => { if (!cancelled) setState({ key, drafts: parseUnsentSubmissions(raw) }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [key]);

  // Read-modify-write under a per-form lock so overlapping updates are kept.
  const update = useCallback((change: (drafts: UnsentSubmission[]) => UnsentSubmission[]) => {
    if (!key) return Promise.resolve();
    const run = async () => {
      const next = change(parseUnsentSubmissions(await AsyncStorage.getItem(key)));
      if (next.length) await AsyncStorage.setItem(key, JSON.stringify(next));
      else await AsyncStorage.removeItem(key);
      setState((current) => (current.key === key ? { key, drafts: next } : current));
    };
    const operation = lock.current.then(run, run);
    lock.current = operation.catch(() => {});
    return operation.catch(() => {});
  }, [key]);

  const record = useCallback(
    (input: { body: Record<string, unknown>; values?: Record<string, unknown>; label: string; error: string }) =>
      update((drafts) => recordUnsent(drafts, input, new Date(), newDraftId)),
    [update],
  );
  const resolve = useCallback(
    (body: Record<string, unknown>) => update((drafts) => resolveUnsent(drafts, body)),
    [update],
  );
  const discard = useCallback(
    (id: string) => update((drafts) => discardUnsent(drafts, id)),
    [update],
  );

  return { drafts: state.key === key ? state.drafts : [], record, resolve, discard };
}
