/**
 * Reads the query parameters a scanned QR label's buttons add to a track page
 * (for example `/green-track?machine=4&open=pre-use`) and removes them from
 * the address bar, so a refresh or the back button doesn't open the form again.
 * Returns null when none of the keys are present.
 */
export function takeLinkParams<K extends string>(keys: readonly K[]): Partial<Record<K, string>> | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const found: Partial<Record<K, string>> = {};
  let any = false;
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      found[key] = value;
      url.searchParams.delete(key);
      any = true;
    }
  }
  if (!any) return null;
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return found;
}
