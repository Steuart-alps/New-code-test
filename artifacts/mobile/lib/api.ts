/**
 * Lightweight fetch wrapper for non-spec API endpoints (fix-track, traintrack,
 * doctrack, auth).  The token is kept in module scope and set by AuthContext.
 *
 * Generated hooks from @workspace/api-client-react use their own `customFetch`
 * which picks up the token via `setAuthTokenGetter` (also called from
 * AuthContext).  Both paths share the same EXPO_PUBLIC_DOMAIN base.
 *
 * Keep this module import-free: tests load it directly with Node.
 */

let _token: string | null = null;
let _unauthorizedHandler: (() => void) | null = null;

/**
 * The API host from EXPO_PUBLIC_DOMAIN, without protocol or trailing slash.
 * Accepts either `api.example.com` or `https://api.example.com`. Returns null
 * when the variable is missing or unusable, so callers never build
 * `https://undefined` URLs.
 */
export function apiDomain(): string | null {
  const raw = (process.env.EXPO_PUBLIC_DOMAIN ?? '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!raw || raw === 'undefined' || raw === 'null' || /[\s/]/.test(raw)) return null;
  return raw;
}

/** Absolute API origin, or null when EXPO_PUBLIC_DOMAIN is not configured. */
export function apiBaseUrl(): string | null {
  const domain = apiDomain();
  return domain ? `https://${domain}` : null;
}

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

/** The signed-in bearer, for requests apiFetch cannot make (image headers). */
export function getToken(): string | null {
  return _token;
}

/**
 * Register the handler for a 401 on a request made with the signed-in
 * bearer (AuthContext clears credentials and the router returns to login).
 * Requests that carry no bearer (sign-in, 2FA) or a different bearer (a
 * replay bound to an older session) never trigger it, so a wrong password
 * stays an inline error. Pass null to clear.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  _unauthorizedHandler = handler;
}

export async function apiFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const base = apiBaseUrl() ?? '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  if (_token && !headers.Authorization) {
    headers['Authorization'] = `Bearer ${_token}`;
  }
  const sentWithSessionToken = !!_token && headers.Authorization === `Bearer ${_token}`;
  const res = await fetch(`${base}${path}`, { ...options, headers });
  if (res.status === 401 && sentWithSessionToken && headers.Authorization === `Bearer ${_token}`) {
    try {
      _unauthorizedHandler?.();
    } catch {
      // Never let the handler hide the original error.
    }
  }
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
