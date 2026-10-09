/**
 * Lightweight fetch wrapper for non-spec API endpoints (fix-track, traintrack,
 * doctrack, auth).  The token is kept in module scope and set by AuthContext.
 *
 * Generated hooks from @workspace/api-client-react use their own `customFetch`
 * which picks up the token via `setAuthTokenGetter` (also called from
 * AuthContext).  Both paths share the same EXPO_PUBLIC_DOMAIN base.
 */

let _token: string | null = null;

export const MOBILE_LOGIN_CHALLENGE_INVALID_CODE = 'MOBILE_LOGIN_CHALLENGE_INVALID';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isInvalidMobileLoginChallenge(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.code === MOBILE_LOGIN_CHALLENGE_INVALID_CODE;
}

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
  if (_token && !headers.Authorization) {
    headers['Authorization'] = `Bearer ${_token}`;
  }
  const res = await fetch(`${base}${path}`, { ...options, headers });
  if (res.status === 204 || res.status === 205) return undefined as T;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status);
    return undefined as T;
  }
  if (!res.ok) {
    const errorData = data !== null && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : undefined;
    throw new ApiError(
      typeof errorData?.error === 'string' ? errorData.error : `Request failed (${res.status})`,
      res.status,
      typeof errorData?.code === 'string' ? errorData.code : undefined,
    );
  }
  return data as T;
}
