export type CustomFetchOptions = RequestInit & {
  responseType?: "json" | "text" | "blob" | "auto";
};

export type ErrorType<T = unknown> = ApiError<T>;

export type BodyType<T> = T;

export type AuthTokenGetter = () => Promise<string | null> | string | null;

const NO_BODY_STATUS = new Set([204, 205, 304]);
const DEFAULT_JSON_ACCEPT = "application/json, application/problem+json";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ---------------------------------------------------------------------------
// Module-level configuration
// ---------------------------------------------------------------------------

let _baseUrl: string | null = null;
let _authTokenGetter: AuthTokenGetter | null = null;
let _clientIdGetter: (() => number | null) | null = null;

export function setClientIdGetter(getter: (() => number | null) | null): void {
  _clientIdGetter = getter;
}

/**
 * Set a base URL that is prepended to every relative request URL
 * (i.e. paths that start with `/`).
 *
 * Useful for Expo bundles that need to call a remote API server.
 * Pass `null` to clear the base URL.
 */
export function setBaseUrl(url: string | null): void {
  _baseUrl = url ? url.replace(/\/+$/, "") : null;
}

/**
 * Register a getter that supplies a bearer auth token.  Before every fetch
 * the getter is invoked; when it returns a non-null string, an
 * `Authorization: Bearer <token>` header is attached to the request.
 *
 * Useful for Expo bundles making token-gated API calls.
 * Pass `null` to clear the getter.
 */
export function setAuthTokenGetter(getter: AuthTokenGetter | null): void {
  _authTokenGetter = getter;
}

export type CsrfTokenProvider = {
  get: () => Promise<string | null> | string | null;
  reset: () => void;
};

let _csrfTokenProvider: CsrfTokenProvider | null = null;

/**
 * Register a provider for the session-bound CSRF token that the API requires
 * on cookie-authenticated POST/PUT/PATCH/DELETE requests in production. The
 * token is sent as `X-CSRF-Token` on those requests unless an Authorization
 * header is present (bearer requests are exempt). `reset` is called after a
 * 401 or 403 so a stale token is not reused. Pass `null` to clear.
 */
export function setCsrfTokenProvider(provider: CsrfTokenProvider | null): void {
  _csrfTokenProvider = provider;
}

let _unauthorizedHandler: (() => void) | null = null;

/**
 * Register a handler invoked whenever any API response comes back 401.
 * Lets the app clear its auth state and route to the login screen when a
 * session expires mid-use. Pass `null` to clear.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  _unauthorizedHandler = handler;
}

let _paymentRequiredHandler: (() => void) | null = null;

/**
 * Register a handler invoked whenever any API response comes back 402
 * (payment required — e.g. free trial expired without a subscription).
 * Lets the app switch to a billing-required screen mid-session. Pass `null`
 * to clear.
 */
export function setPaymentRequiredHandler(handler: (() => void) | null): void {
  _paymentRequiredHandler = handler;
}

export type OverrideReasonRequest = {
  method: string;
  url: string;
  /** The server's explanation, suitable for showing to the user. */
  message: string;
};

/** Resolves to the reason the user gave, or null when they cancelled. */
export type OverrideReasonHandler = (info: OverrideReasonRequest) => Promise<string | null>;

let _overrideReasonHandler: OverrideReasonHandler | null = null;

/** Header carrying an owner's reason for changing a record past its correction window. */
export const OVERRIDE_REASON_HEADER = "X-Override-Reason";
/** Error code the API sends (HTTP 423) when such a change needs a reason. */
export const OVERRIDE_REASON_REQUIRED_CODE = "OVERRIDE_REASON_REQUIRED";

/**
 * Register a handler that asks the user why they are changing a record older
 * than its correction window. When a mutation is answered 423 with code
 * OVERRIDE_REASON_REQUIRED, the handler is called; a returned reason retries
 * the same request once with the `X-Override-Reason` header (URI-encoded),
 * while null leaves the original 423 error in place. Pass `null` to clear.
 */
export function setOverrideReasonHandler(handler: OverrideReasonHandler | null): void {
  _overrideReasonHandler = handler;
}

export type RecordSignatureRequest = {
  method: string;
  url: string;
  /** The server's explanation, suitable for showing to the user. */
  message: string;
  /** The name of the login that will sign, when the server gave it. */
  signedBy: string | null;
};

/** Resolves to the token of the stored signature, or null when the user cancelled. */
export type RecordSignatureHandler = (info: RecordSignatureRequest) => Promise<string | null>;

let _recordSignatureHandler: RecordSignatureHandler | null = null;

/** Header carrying the token of the drawn signature for a recorded check. */
export const RECORD_SIGNATURE_HEADER = "X-Record-Signature";
/** Error code the API sends (HTTP 428) when saving a check needs a signature. */
export const SIGNATURE_REQUIRED_CODE = "SIGNATURE_REQUIRED";

/**
 * Register a handler that asks the user to sign a check they are saving. When
 * a mutation is answered 428 with code SIGNATURE_REQUIRED, the handler is
 * called; a returned token retries the same request once with the
 * `X-Record-Signature` header, while null leaves the original 428 error in
 * place. Pass `null` to clear.
 */
export function setRecordSignatureHandler(handler: RecordSignatureHandler | null): void {
  _recordSignatureHandler = handler;
}

/** The server's message and signer when an error body asks for a signature, else null. */
export function signatureRequiredInfo(data: unknown): { message: string; signedBy: string | null } | null {
  if (!data || typeof data !== "object") return null;
  if ((data as Record<string, unknown>).code !== SIGNATURE_REQUIRED_CODE) return null;
  return {
    message: getStringField(data, "error") ?? "Sign to save this record.",
    signedBy: getStringField(data, "signedBy") ?? null,
  };
}

/** Whether a request body can be sent a second time unchanged. */
export function isReplayableBody(body: unknown): boolean {
  if (body == null || typeof body === "string") return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  return false;
}

/** The server's message when an error body asks for an override reason, else null. */
export function overrideReasonMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  if ((data as Record<string, unknown>).code !== OVERRIDE_REASON_REQUIRED_CODE) return null;
  return getStringField(data, "error") ?? "This record is more than a day old. Add a reason to change it.";
}

export type ApiMutationObserver = (
  method: string,
  url: string,
) => (() => void) | void;

let _mutationObserver: ApiMutationObserver | null = null;

/**
 * Register an observer for state-changing requests (POST/PUT/PATCH). It is
 * called before the request is sent and may return a callback that runs only
 * after a successful (2xx, parsed) response. Observers must not throw; any
 * error is swallowed so they can never affect the request. Pass `null` to
 * clear.
 */
export function setMutationObserver(observer: ApiMutationObserver | null): void {
  _mutationObserver = observer;
}

function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

function resolveMethod(input: RequestInfo | URL, explicitMethod?: string): string {
  if (explicitMethod) return explicitMethod.toUpperCase();
  if (isRequest(input)) return input.method.toUpperCase();
  return "GET";
}

// Use loose check for URL — some runtimes (e.g. React Native) polyfill URL
// differently, so `instanceof URL` can fail.
function isUrl(input: RequestInfo | URL): input is URL {
  return typeof URL !== "undefined" && input instanceof URL;
}

function applyBaseUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (!_baseUrl) return input;
  const url = resolveUrl(input);
  // Only prepend to relative paths (starting with /)
  if (!url.startsWith("/")) return input;

  const absolute = `${_baseUrl}${url}`;
  if (typeof input === "string") return absolute;
  if (isUrl(input)) return new URL(absolute);
  return new Request(absolute, input as Request);
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (isUrl(input)) return input.toString();
  return input.url;
}

function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const headers = new Headers();

  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return headers;
}

function getMediaType(headers: Headers): string | null {
  const value = headers.get("content-type");
  return value ? value.split(";", 1)[0].trim().toLowerCase() : null;
}

function isJsonMediaType(mediaType: string | null): boolean {
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function isTextMediaType(mediaType: string | null): boolean {
  return Boolean(
    mediaType &&
      (mediaType.startsWith("text/") ||
        mediaType === "application/xml" ||
        mediaType === "text/xml" ||
        mediaType.endsWith("+xml") ||
        mediaType === "application/x-www-form-urlencoded"),
  );
}

// Use strict equality: in browsers, `response.body` is `null` when the
// response genuinely has no content.  In React Native, `response.body` is
// always `undefined` because the ReadableStream API is not implemented —
// even when the response carries a full payload readable via `.text()` or
// `.json()`.  Loose equality (`== null`) matches both `null` and `undefined`,
// which causes every React Native response to be treated as empty.
function hasNoBody(response: Response, method: string): boolean {
  if (method === "HEAD") return true;
  if (NO_BODY_STATUS.has(response.status)) return true;
  if (response.headers.get("content-length") === "0") return true;
  if (response.body === null) return true;
  return false;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string") return undefined;

  const trimmed = candidate.trim();
  return trimmed === "" ? undefined : trimmed;
}

function truncate(text: string, maxLength = 300): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function stripHtml(text: string): string {
  // If the body looks like an HTML error page, surface a concise message
  // instead of dumping markup into the UI.
  const trimmed = text.trim();
  if (/^<(!doctype|html|head|body)/i.test(trimmed)) {
    const titleMatch = trimmed.match(/<title>([^<]+)<\/title>/i);
    const preMatch = trimmed.match(/<pre>([^<]+)<\/pre>/i);
    const inner = (preMatch?.[1] ?? titleMatch?.[1] ?? "").trim();
    return inner ? truncate(inner) : "Server returned an HTML error page";
  }
  return text;
}

function buildErrorMessage(response: Response, data: unknown): string {
  const prefix = `HTTP ${response.status} ${response.statusText}`;

  if (typeof data === "string") {
    const text = stripHtml(data).trim();
    return text ? `${prefix}: ${truncate(text)}` : prefix;
  }

  const title = getStringField(data, "title");
  const detail = getStringField(data, "detail");
  const message =
    getStringField(data, "message") ??
    getStringField(data, "error_description") ??
    getStringField(data, "error");

  if (title && detail) return `${prefix}: ${title} — ${detail}`;
  if (detail) return `${prefix}: ${detail}`;
  if (message) return `${prefix}: ${message}`;
  if (title) return `${prefix}: ${title}`;

  return prefix;
}

export class ApiError<T = unknown> extends Error {
  readonly name = "ApiError";
  readonly status: number;
  readonly statusText: string;
  readonly data: T | null;
  readonly headers: Headers;
  readonly response: Response;
  readonly method: string;
  readonly url: string;

  constructor(
    response: Response,
    data: T | null,
    requestInfo: { method: string; url: string },
  ) {
    super(buildErrorMessage(response, data));
    Object.setPrototypeOf(this, new.target.prototype);

    this.status = response.status;
    this.statusText = response.statusText;
    this.data = data;
    this.headers = response.headers;
    this.response = response;
    this.method = requestInfo.method;
    this.url = response.url || requestInfo.url;
  }
}

export class ResponseParseError extends Error {
  readonly name = "ResponseParseError";
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly response: Response;
  readonly method: string;
  readonly url: string;
  readonly rawBody: string;
  readonly cause: unknown;

  constructor(
    response: Response,
    rawBody: string,
    cause: unknown,
    requestInfo: { method: string; url: string },
  ) {
    super(
      `Failed to parse response from ${requestInfo.method} ${response.url || requestInfo.url} ` +
        `(${response.status} ${response.statusText}) as JSON`,
    );
    Object.setPrototypeOf(this, new.target.prototype);

    this.status = response.status;
    this.statusText = response.statusText;
    this.headers = response.headers;
    this.response = response;
    this.method = requestInfo.method;
    this.url = response.url || requestInfo.url;
    this.rawBody = rawBody;
    this.cause = cause;
  }
}

async function parseJsonBody(
  response: Response,
  requestInfo: { method: string; url: string },
): Promise<unknown> {
  const raw = await response.text();
  const normalized = stripBom(raw);

  if (normalized.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch (cause) {
    throw new ResponseParseError(response, raw, cause, requestInfo);
  }
}

async function parseErrorBody(response: Response, method: string): Promise<unknown> {
  if (hasNoBody(response, method)) {
    return null;
  }

  const mediaType = getMediaType(response.headers);

  // Fall back to text when blob() is unavailable (e.g. some React Native builds).
  if (mediaType && !isJsonMediaType(mediaType) && !isTextMediaType(mediaType)) {
    return typeof response.blob === "function" ? response.blob() : response.text();
  }

  const raw = await response.text();
  const normalized = stripBom(raw);
  const trimmed = normalized.trim();

  if (trimmed === "") {
    return null;
  }

  if (isJsonMediaType(mediaType) || looksLikeJson(normalized)) {
    try {
      return JSON.parse(normalized);
    } catch {
      return raw;
    }
  }

  return raw;
}

function inferResponseType(response: Response): "json" | "text" | "blob" {
  const mediaType = getMediaType(response.headers);

  if (isJsonMediaType(mediaType)) return "json";
  if (isTextMediaType(mediaType) || mediaType == null) return "text";
  return "blob";
}

async function parseSuccessBody(
  response: Response,
  responseType: "json" | "text" | "blob" | "auto",
  requestInfo: { method: string; url: string },
): Promise<unknown> {
  if (hasNoBody(response, requestInfo.method)) {
    return null;
  }

  const effectiveType =
    responseType === "auto" ? inferResponseType(response) : responseType;

  switch (effectiveType) {
    case "json":
      return parseJsonBody(response, requestInfo);

    case "text": {
      const text = await response.text();
      return text === "" ? null : text;
    }

    case "blob":
      if (typeof response.blob !== "function") {
        throw new TypeError(
          "Blob responses are not supported in this runtime. " +
            "Use responseType \"json\" or \"text\" instead.",
        );
      }
      return response.blob();
  }
}

/** Whether the URL query or a JSON object body already names a clientId. */
export function callerChoseClientId(url: string, body: unknown): boolean {
  const queryStart = url.indexOf("?");
  if (queryStart !== -1) {
    const query = url.slice(queryStart + 1).split("#", 1)[0];
    if (new URLSearchParams(query).has("clientId")) return true;
  }
  if (typeof body === "string" && looksLikeJson(body)) {
    try {
      const parsed: unknown = JSON.parse(body);
      return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed)
        && Object.prototype.hasOwnProperty.call(parsed, "clientId");
    } catch {
      return false;
    }
  }
  return false;
}

/** Adds `clientId` to a URL's query string, before any fragment. */
export function appendClientId(url: string, clientId: number): string {
  const hashStart = url.indexOf("#");
  const base = hashStart === -1 ? url : url.slice(0, hashStart);
  const hash = hashStart === -1 ? "" : url.slice(hashStart);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}clientId=${encodeURIComponent(String(clientId))}${hash}`;
}

export async function customFetch<T = unknown>(
  input: RequestInfo | URL,
  options: CustomFetchOptions = {},
): Promise<T> {
  input = applyBaseUrl(input);
  const { responseType = "auto", headers: headersInit, ...init } = options;

  const method = resolveMethod(input, init.method);

  if (init.body != null && (method === "GET" || method === "HEAD")) {
    throw new TypeError(`customFetch: ${method} requests cannot have a body.`);
  }

  const headers = mergeHeaders(isRequest(input) ? input.headers : undefined, headersInit);

  if (
    typeof init.body === "string" &&
    !headers.has("content-type") &&
    looksLikeJson(init.body)
  ) {
    headers.set("content-type", "application/json");
  }

  if (responseType === "json" && !headers.has("accept")) {
    headers.set("accept", DEFAULT_JSON_ACCEPT);
  }

  // Attach bearer token when an auth getter is configured and no
  // Authorization header has been explicitly provided.
  if (_authTokenGetter && !headers.has("authorization")) {
    const token = await _authTokenGetter();
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
  }

  // Cookie-authenticated mutations must carry the session's CSRF token.
  const sendsCsrfToken =
    _csrfTokenProvider !== null &&
    UNSAFE_METHODS.has(method) &&
    !headers.has("authorization") &&
    !headers.has("x-csrf-token");
  if (sendsCsrfToken) {
    const token = await _csrfTokenProvider!.get();
    if (token) {
      headers.set("x-csrf-token", token);
    }
  }

  // Scope every request (reads and writes) to the selected business so a
  // consultant working in another client never falls back to their home one.
  // A clientId the caller already chose, in the URL or a JSON body, wins.
  if (_clientIdGetter) {
    const clientId = _clientIdGetter();
    const rawUrl = resolveUrl(input);
    if (clientId !== null && !callerChoseClientId(rawUrl, init.body)) {
      const patchedUrl = appendClientId(rawUrl, clientId);
      if (typeof input === "string") input = patchedUrl;
      else if (isUrl(input)) input = new URL(patchedUrl);
      else input = new Request(patchedUrl, input as Request);
    }
  }

  const requestInfo = { method, url: resolveUrl(input) };

  let onMutationSuccess: (() => void) | void = undefined;
  if (_mutationObserver && (method === "POST" || method === "PUT" || method === "PATCH")) {
    try {
      onMutationSuccess = _mutationObserver(method, requestInfo.url);
    } catch {
      // observers must never affect the request
    }
  }

  let response = await fetch(input, { ...init, method, headers, credentials: "include" });

  // Saving a recorded check needs the user's drawn signature, and an owner
  // changing a record past its correction window must give a reason. Ask for
  // each at most once, then resend the same request with what was given.
  const canResend = UNSAFE_METHODS.has(method) && !isRequest(input) && isReplayableBody(init.body);
  let retryHeaders = headers;
  let askedSignature = false;
  let askedReason = false;
  for (;;) {
    if (response.status === 428 && canResend && !askedSignature && _recordSignatureHandler !== null) {
      askedSignature = true;
      const unsignedData = await parseErrorBody(response, method);
      const info = signatureRequiredInfo(unsignedData);
      let token: string | null = null;
      if (info) {
        try {
          token = (await _recordSignatureHandler({ method, url: requestInfo.url, ...info }))?.trim() || null;
        } catch {
          token = null;
        }
      }
      if (!token) throw new ApiError(response, unsignedData, requestInfo);
      retryHeaders = new Headers(retryHeaders);
      retryHeaders.set(RECORD_SIGNATURE_HEADER, token);
      response = await fetch(input, { ...init, method, headers: retryHeaders, credentials: "include" });
      continue;
    }
    if (response.status === 423 && canResend && !askedReason && _overrideReasonHandler !== null) {
      askedReason = true;
      const lockedData = await parseErrorBody(response, method);
      const message = overrideReasonMessage(lockedData);
      let reason: string | null = null;
      if (message) {
        try {
          reason = (await _overrideReasonHandler({ method, url: requestInfo.url, message }))?.trim() || null;
        } catch {
          reason = null;
        }
      }
      if (!reason) throw new ApiError(response, lockedData, requestInfo);
      retryHeaders = new Headers(retryHeaders);
      retryHeaders.set(OVERRIDE_REASON_HEADER, encodeURIComponent(reason));
      response = await fetch(input, { ...init, method, headers: retryHeaders, credentials: "include" });
      continue;
    }
    break;
  }

  if (!response.ok) {
    if (sendsCsrfToken && (response.status === 401 || response.status === 403)) {
      try {
        _csrfTokenProvider?.reset();
      } catch {
        // never let the provider break error propagation
      }
    }
    if (response.status === 401 && _unauthorizedHandler) {
      try {
        _unauthorizedHandler();
      } catch {
        // never let the handler break error propagation
      }
    }
    if (response.status === 402 && _paymentRequiredHandler) {
      try {
        _paymentRequiredHandler();
      } catch {
        // never let the handler break error propagation
      }
    }
    const errorData = await parseErrorBody(response, method);
    throw new ApiError(response, errorData, requestInfo);
  }

  const body = (await parseSuccessBody(response, responseType, requestInfo)) as T;
  if (onMutationSuccess) {
    try {
      onMutationSuccess();
    } catch {
      // observers must never affect the response
    }
  }
  return body;
}
