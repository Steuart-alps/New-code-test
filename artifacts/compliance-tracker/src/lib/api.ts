import {
  appendClientId,
  callerChoseClientId,
  correctiveActionRequiredInfo,
  correctiveActionsHeaderValue,
  CORRECTIVE_ACTIONS_HEADER,
  isReplayableBody,
  OVERRIDE_REASON_HEADER,
  overrideReasonMessage,
  RECORD_SIGNATURE_HEADER,
  setCsrfTokenProvider,
  signatureRequiredInfo,
  type OverrideReasonHandler,
  type RecordSignatureHandler,
  type CorrectiveActionHandler,
} from "@workspace/api-client-react";

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

/** Forget the cached token, e.g. after sign-out destroys the session it belonged to. */
export function clearCsrfToken(): void {
  csrfToken = null;
}

// Generated API hooks share the same session-bound token.
setCsrfTokenProvider({ get: getCsrfToken, reset: clearCsrfToken });

/**
 * Adds the session's CSRF token to a state-changing request sent with plain
 * `fetch`. Prefer `apiFetch`; this is for page helpers that build their own
 * request.
 */
export async function withCsrfToken(init: RequestInit = {}): Promise<RequestInit> {
  const method = (init.method ?? "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization") && !headers.has("X-CSRF-Token")) {
    const token = await getCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  return { ...init, headers };
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

let clientIdGetter: (() => number | null) | null = null;
let unauthorizedHandler: (() => void) | null = null;
let paymentRequiredHandler: (() => void) | null = null;

/** Mirrors the generated client's setClientIdGetter for hand-written fetches. */
export function setApiFetchClientIdGetter(getter: (() => number | null) | null): void {
  clientIdGetter = getter;
}

/** Mirrors the generated client's setUnauthorizedHandler (any 401 response). */
export function setApiFetchUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Mirrors the generated client's setPaymentRequiredHandler (any 402 response). */
export function setApiFetchPaymentRequiredHandler(handler: (() => void) | null): void {
  paymentRequiredHandler = handler;
}

let overrideReasonHandler: OverrideReasonHandler | null = null;

/** Mirrors the generated client's setOverrideReasonHandler for hand-written fetches. */
export function setApiFetchOverrideReasonHandler(handler: OverrideReasonHandler | null): void {
  overrideReasonHandler = handler;
}

let recordSignatureHandler: RecordSignatureHandler | null = null;

/** Mirrors the generated client's setRecordSignatureHandler for hand-written fetches. */
export function setApiFetchRecordSignatureHandler(handler: RecordSignatureHandler | null): void {
  recordSignatureHandler = handler;
}

let correctiveActionHandler: CorrectiveActionHandler | null = null;

/** Mirrors the generated client's setCorrectiveActionHandler for hand-written fetches. */
export function setApiFetchCorrectiveActionHandler(handler: CorrectiveActionHandler | null): void {
  correctiveActionHandler = handler;
}

/**
 * `fetch` for hand-written mutations of track records. When the API answers
 * 428 CORRECTIVE_ACTION_REQUIRED (a check with a fail must say what was done
 * about it), asks for the corrective actions; when it answers
 * 428 SIGNATURE_REQUIRED (a recorded check must be signed), asks for a drawn
 * signature; when it answers 423 OVERRIDE_REASON_REQUIRED (an owner changing a
 * record older than its correction window), asks for a reason. Each is asked
 * at most once through the registered handlers, and the same request is sent
 * again with the answer. If the user cancels, or the request cannot be resent,
 * the last response is returned unchanged.
 */
export async function fetchWithOverrideReason(url: string, init: RequestInit = {}): Promise<Response> {
  let res = await fetch(url, init);
  const method = (init.method ?? "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method) || !isReplayableBody(init.body)) return res;
  let headers = new Headers(init.headers);
  let askedSignature = false;
  let askedReason = false;
  let askedCorrective = false;
  for (;;) {
    const corrective = res.status === 428 && !askedCorrective && correctiveActionHandler
      ? correctiveActionRequiredInfo(await res.clone().json().catch(() => null))
      : null;
    if (corrective && correctiveActionHandler) {
      askedCorrective = true;
      let answers: Record<string, string> | null = null;
      try {
        answers = await correctiveActionHandler({ method, url, ...corrective });
      } catch {
        answers = null;
      }
      if (!answers) return res;
      headers = new Headers(headers);
      headers.set(CORRECTIVE_ACTIONS_HEADER, correctiveActionsHeaderValue(answers));
      res = await fetch(url, { ...init, headers });
      continue;
    }
    if (res.status === 428 && !askedSignature && recordSignatureHandler) {
      askedSignature = true;
      const info = signatureRequiredInfo(await res.clone().json().catch(() => null));
      if (!info) return res;
      let token: string | null = null;
      try {
        token = (await recordSignatureHandler({ method, url, ...info }))?.trim() || null;
      } catch {
        token = null;
      }
      if (!token) return res;
      headers = new Headers(headers);
      headers.set(RECORD_SIGNATURE_HEADER, token);
      res = await fetch(url, { ...init, headers });
      continue;
    }
    if (res.status === 423 && !askedReason && overrideReasonHandler) {
      askedReason = true;
      const message = overrideReasonMessage(await res.clone().json().catch(() => null));
      if (!message) return res;
      let reason: string | null = null;
      try {
        reason = (await overrideReasonHandler({ method, url, message }))?.trim() || null;
      } catch {
        reason = null;
      }
      if (!reason) return res;
      headers = new Headers(headers);
      headers.set(OVERRIDE_REASON_HEADER, encodeURIComponent(reason));
      res = await fetch(url, { ...init, headers });
      continue;
    }
    return res;
  }
}

/**
 * Adds the selected business (`clientId`) to an API path or URL so reads and
 * writes go to the business the user is working in, not a consultant's home
 * business. A clientId already in the URL or JSON body is left alone. Use it
 * in page-local fetch helpers; `apiFetch` already does this.
 */
export function withActiveClient(url: string, body?: unknown): string {
  const clientId = clientIdGetter?.() ?? null;
  if (clientId === null || callerChoseClientId(url, body)) return url;
  return appendClientId(url, clientId);
}

/** Runs the shared 401/402 handlers for a response from a hand-written fetch. */
export function notifyAuthStatus(response: Response): void {
  const handler = response.status === 401 ? unauthorizedHandler
    : response.status === 402 ? paymentRequiredHandler
      : null;
  if (!handler) return;
  try {
    handler();
  } catch {
    // Handlers must never affect the caller's error handling.
  }
}

export async function apiFetch(path: string, init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  // Sign-in, 2FA and session endpoints act on the account, not a business.
  const isAuthPath = path.startsWith("/auth/");
  // Analytics events must never identify a business, so never add its id.
  const isAnalyticsPath = path.startsWith("/analytics/");
  if (!isAuthPath && !isAnalyticsPath) path = withActiveClient(path, init?.body);
  const mutationSucceeded = beginApiMutation(method, path);
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("Authorization")) {
    const token = await getCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  const res = await fetchWithOverrideReason(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (res.status === 401 || res.status === 403) {
    // A session rotation or expiry can invalidate the cached token. The next
    // request will obtain a fresh token rather than reusing stale state.
    csrfToken = null;
  }
  // Sign-in and 2FA endpoints answer a wrong password or code with 401; the
  // form shows that itself, so only other requests end the session.
  if (!isAuthPath) notifyAuthStatus(res);
  if (res.ok) mutationSucceeded();
  return res;
}

export async function getApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error.length > 0 ? body.error : fallback;
}
