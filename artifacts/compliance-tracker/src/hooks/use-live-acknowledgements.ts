import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { apiFetch } from "@/lib/api";

// How often an open acknowledgements dialog checks for signatures staff record
// on their own devices. Checks pause while the tab is hidden.
export const ACK_REFRESH_MS = 10_000;

interface AckRow { id: number; acknowledged_at: string }

/** Replaces rows with the same id and appends new ones. */
export function mergeAcknowledgements<T extends AckRow>(prev: T[], incoming: T[]): T[] {
  const byId = new Map(prev.map(a => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return Array.from(byId.values());
}

function latestAcknowledgementId(acks: AckRow[]): number | null {
  let latest: AckRow | null = null;
  for (const a of acks) {
    if (!latest || new Date(a.acknowledged_at).getTime() > new Date(latest.acknowledged_at).getTime()) latest = a;
  }
  return latest?.id ?? null;
}

/**
 * While `listPath` is set and the tab is visible, polls the acknowledgements
 * list and merges new or renewed rows into `acks`. Each poll passes the most
 * recent row's id as `sinceId`, so only rows from around then onwards come
 * back. Other dialog state (ticks, typed names) is left alone.
 */
export function useLiveAcknowledgements<T extends AckRow>(
  listPath: string | null,
  acks: T[],
  setAcks: Dispatch<SetStateAction<T[]>>,
): void {
  const sinceRef = useRef<number | null>(null);
  sinceRef.current = latestAcknowledgementId(acks);

  useEffect(() => {
    if (!listPath) return;
    let cancelled = false;
    let inFlight = false;
    async function refresh() {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const since = sinceRef.current;
        const res = await apiFetch(since ? `${listPath}?sinceId=${since}` : listPath!);
        if (!res.ok || cancelled) return;
        const incoming = await res.json() as T[];
        if (!cancelled && incoming.length) setAcks(prev => mergeAcknowledgements(prev, incoming));
      } catch {
        // The next tick retries.
      } finally {
        inFlight = false;
      }
    }
    const timer = window.setInterval(refresh, ACK_REFRESH_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [listPath, setAcks]);
}
