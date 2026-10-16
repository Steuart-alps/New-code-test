/**
 * Scrubbing for the error reports the API and the web app send to Sentry.
 *
 * A report keeps what helps fix the fault: the error, its stack, the request
 * method and the URL path shape, tags, the environment and the release. It
 * loses anything that can carry a secret or personal data: request bodies,
 * headers, cookies, query strings and fragments, bearer links (sign-off,
 * contractor, download and other token paths), credentials inside URLs,
 * email addresses and long opaque values in messages.
 *
 * Used as `beforeSend` and `beforeSendTransaction` by both SDKs, so it is
 * written against plain objects rather than Sentry's types.
 */

// This library is compiled without DOM or Node types; both runtimes have URL.
declare const URL: new (url: string, base?: string) => { origin: string; pathname: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bearer tokens in this app are 32 random bytes as hex (64 chars) or
// base64url (43 chars); TOTP secrets are base32. Identifiers such as
// "kitchen_temperature_readings_2024" or "service-price-preflight" are kept.
const OPAQUE_IN_TEXT = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*|(?<![\w/])\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;
const SECRET_PARAM = /\b(token|password|passcode|secret|signature|sig|code|key|apikey|api_key|access_token|refresh_token|session)=([^&\s"'<>]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[^\s"'<>]+/gi;

export const REDACTED = "[redacted]";

function isOpaqueToken(value: string): boolean {
  if (value.length < 20 || !/^[A-Za-z0-9_-]+$/.test(value) || UUID.test(value)) return false;
  if (/^[0-9a-f]{32,}$/i.test(value)) return true; // hex
  if (/^[A-Z2-7]{26,}$/.test(value) && /[2-7]/.test(value)) return true; // base32
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value); // base64url and API keys
}

/** Replace token-like path segments, keeping ids, UUIDs and words. */
export function redactPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // keep the raw segment
      }
      return isOpaqueToken(decoded) ? REDACTED : segment;
    })
    .join("/");
}

/**
 * An absolute or relative URL reduced to origin and path, with token-like
 * segments redacted. Query string, fragment and credentials are dropped.
 */
export function redactUrl(value: string): string {
  const base = "https://redacted.invalid";
  try {
    const url = new URL(value, base);
    const path = redactPath(url.pathname);
    return url.origin === base && !value.startsWith(base) ? path : `${url.origin}${path}`;
  } catch {
    return REDACTED;
  }
}

/** Free text (error messages, breadcrumb messages, transaction names). */
export function redactText(value: string): string {
  return value
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(SECRET_PARAM, `$1=${REDACTED}`)
    .replace(URL_QUERY, "$1")
    .replace(EMAIL, "[email]")
    .replace(OPAQUE_IN_TEXT, (match) => (isOpaqueToken(match) ? REDACTED : match));
}

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null;

const URL_KEYS = new Set(["url", "from", "to", "http.url", "url.full", "http.target", "url.path", "server.address.url"]);

/** Scrub a key/value bag such as breadcrumb or span data. */
function scrubData(data: Loose): void {
  for (const key of Object.keys(data)) {
    const value = data[key];
    const lower = key.toLowerCase();
    if (lower.includes("query") || lower.includes("fragment") || lower.includes("cookie")
      || lower.includes("authorization") || lower === "arguments" || lower.endsWith(".body")
      || lower.startsWith("http.request.header") || lower.startsWith("http.response.header")) {
      delete data[key];
    } else if (typeof value === "string") {
      data[key] = URL_KEYS.has(lower) || lower.endsWith(".url") ? redactUrl(value) : redactText(value);
    }
  }
}

function scrubSpanLike(span: Loose): void {
  if (typeof span.description === "string") span.description = redactText(span.description);
  if (isObject(span.data)) scrubData(span.data);
}

/**
 * Remove secrets and personal data from a Sentry error or transaction event,
 * in place. Returns the same event so it can be used directly as
 * `beforeSend` / `beforeSendTransaction`.
 */
export function scrubErrorReport<T>(event: T): T {
  if (!isObject(event)) return event;
  const e = event as Loose;

  if (isObject(e.request)) {
    const request = e.request;
    for (const key of ["data", "cookies", "headers", "query_string", "env"]) delete request[key];
    if (typeof request.url === "string") request.url = redactUrl(request.url);
  }

  if (isObject(e.user)) {
    for (const key of ["ip_address", "email", "username", "geo"]) delete e.user[key];
  }

  if (typeof e.transaction === "string") e.transaction = redactText(e.transaction);
  if (typeof e.message === "string") e.message = redactText(e.message);
  if (isObject(e.logentry)) {
    if (typeof e.logentry.message === "string") e.logentry.message = redactText(e.logentry.message);
    delete e.logentry.params;
  }

  const exception = isObject(e.exception) ? e.exception : null;
  if (exception && Array.isArray(exception.values)) {
    for (const value of exception.values) {
      if (isObject(value) && typeof value.value === "string") value.value = redactText(value.value);
    }
  }

  if (Array.isArray(e.breadcrumbs)) {
    for (const crumb of e.breadcrumbs) {
      if (!isObject(crumb)) continue;
      if (typeof crumb.message === "string") crumb.message = redactText(crumb.message);
      if (isObject(crumb.data)) scrubData(crumb.data);
    }
  }

  if (isObject(e.contexts)) {
    for (const context of Object.values(e.contexts)) {
      if (isObject(context) && isObject(context.data)) scrubData(context.data);
    }
  }
  if (Array.isArray(e.spans)) {
    for (const span of e.spans) if (isObject(span)) scrubSpanLike(span);
  }

  if (isObject(e.tags)) {
    for (const [key, value] of Object.entries(e.tags)) {
      if (typeof value === "string") e.tags[key] = key === "url" ? redactUrl(value) : redactText(value);
    }
  }

  return event;
}

/** What happened to one report on its way to Sentry. */
export type ErrorReportDelivery =
  | { outcome: "accepted"; statusCode: number }
  | { outcome: "rejected"; statusCode: number }
  | { outcome: "failed" }
  | { outcome: "pending" };

type Transport = { send(envelope: unknown): PromiseLike<unknown> };

/**
 * Records, per event id, whether Sentry accepted each envelope, so an
 * operator's test report can say "Sentry accepted it" (or "Sentry answered
 * 401: check the DSN") instead of only "sent". Keeps the last 50 outcomes.
 */
export function createDeliveryLog() {
  const outcomes = new Map<string, ErrorReportDelivery>();
  const remember = (eventId: string | undefined, delivery: ErrorReportDelivery) => {
    if (!eventId) return;
    outcomes.delete(eventId);
    outcomes.set(eventId, delivery);
    while (outcomes.size > 50) outcomes.delete(outcomes.keys().next().value as string);
  };
  const eventIdOf = (envelope: unknown): string | undefined => {
    const header = Array.isArray(envelope) ? envelope[0] : null;
    return isObject(header) && typeof header.event_id === "string" ? header.event_id : undefined;
  };
  return {
    wrap<T extends Transport>(transport: T): T {
      return {
        ...transport,
        send(envelope: unknown) {
          const eventId = eventIdOf(envelope);
          return Promise.resolve(transport.send(envelope)).then(
            (response) => {
              const statusCode = isObject(response) && typeof response.statusCode === "number" ? response.statusCode : undefined;
              if (statusCode === undefined) remember(eventId, { outcome: "failed" });
              else remember(eventId, { outcome: statusCode >= 200 && statusCode < 300 ? "accepted" : "rejected", statusCode });
              return response;
            },
            (error: unknown) => {
              remember(eventId, { outcome: "failed" });
              throw error;
            },
          );
        },
      };
    },
    outcome(eventId: string): ErrorReportDelivery {
      return outcomes.get(eventId) ?? { outcome: "pending" };
    },
  };
}
