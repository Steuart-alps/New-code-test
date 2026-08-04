/**
 * Lightweight fetch wrapper for non-spec API endpoints (fix-track, traintrack,
 * doctrack, auth).  The token is kept in module scope and set by AuthContext.
 *
 * Generated hooks from @workspace/api-client-react use their own `customFetch`
 * which picks up the token via `setAuthTokenGetter` (also called from
 * AuthContext).  Both paths share the same EXPO_PUBLIC_DOMAIN base.
 */

let _token: string | null = null;

export function setToken(token: string | null): void {
  _token = token;
}

export async function apiFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  const base = domain ? `https://${domain}` : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  if (_token) {
    headers['Authorization'] = `Bearer ${_token}`;
  }
  const res = await fetch(`${base}${path}`, { ...options, headers });
  if (res.status === 204 || res.status === 205) return undefined as T;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return undefined as T;
  }
  if (!res.ok) {
    throw new Error(
      (data as Record<string, string>)?.error ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}
