const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const API_BASE = `${BASE}/api`;

let csrfToken: string | null = null;
let csrfRequest: Promise<string | null> | null = null;

export async function getCsrfToken(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  if (!csrfRequest) {
    csrfRequest = fetch(`${API_BASE}/auth/csrf-token`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = await res.json() as { token?: string };
        csrfToken = body.token ?? null;
        return csrfToken;
      })
      .catch(() => null)
      .finally(() => {
        csrfRequest = null;
      });
  }
  return csrfRequest;
}

type MutationObserver = (method: string, url: string) => (() => void) | void;
let mutationObserver: MutationObserver | null = null;

/** Mirrors the generated client's setMutationObserver for hand-written fetches. */
export function setApiFetchMutationObserver(observer: MutationObserver | null): void {
  mutationObserver = observer;
}

/**
 * Call before sending a hand-written POST/PUT/PATCH; call the returned
 * function only after the response succeeded. Never throws.
 */
export function beginApiMutation(method: string | undefined, url: string): () => void {
  const verb = (method ?? "GET").toUpperCase();
  let onSuccess: (() => void) | void = undefined;
  if (mutationObserver && ["POST", "PUT", "PATCH"].includes(verb)) {
    try {
      onSuccess = mutationObserver(verb, url);
    } catch {
      // Observers must never affect the request.
    }
  }
  return () => {
    if (!onSuccess) return;
    try {
      onSuccess();
    } catch {
      // Observers must never affect the response.
    }
  };
}

export async function apiFetch(path: string, init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  const mutationSucceeded = beginApiMutation(method, path);
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("Authorization")) {
    const token = await getCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (res.status === 401 || res.status === 403) {
    // A session rotation or expiry can invalidate the cached token. The next
    // request will obtain a fresh token rather than reusing stale state.
    csrfToken = null;
  }
  if (res.ok) mutationSucceeded();
  return res;
}

export async function getApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error.length > 0 ? body.error : fallback;
}
