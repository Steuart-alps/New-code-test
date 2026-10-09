// Shared fetch stub for the analytics unit tests: captures the first-party
// POSTs that trackEvent sends to /api/analytics/events through the shared
// apiFetch. No server, network or real data is involved.
import assert from "node:assert/strict";

export const ANALYTICS_URL = "/api/analytics/events";

/** Bundle options so src/lib/api.ts (import.meta.env.BASE_URL) loads in Node. */
export const bundleDefine = { "import.meta.env.BASE_URL": JSON.stringify("/") };

/** Lets queued apiFetch work (CSRF bootstrap, then the POST) settle. */
export const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

/**
 * Installs a fetch stub. `respond` decides the analytics response (default
 * 204); it may throw synchronously or return a rejected promise.
 * Returns the captured analytics payloads as [event, dimensions] pairs.
 */
export function captureAnalytics(respond = () => new Response(null, { status: 204 })) {
  const events = [];
  const requests = [];
  globalThis.fetch = (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/api/auth/csrf-token")) {
      return Promise.resolve(new Response(JSON.stringify({ token: "csrf-test-token" }), { status: 200 }));
    }
    if (target === ANALYTICS_URL) {
      requests.push(init);
      const body = JSON.parse(init.body);
      events.push([body.event, body.dimensions]);
      return respond(init);
    }
    return Promise.reject(new Error(`unexpected request in analytics test: ${target}`));
  };
  return { events, requests };
}

/** Every analytics request is a CSRF-protected, credentialed keepalive POST of {event, dimensions}. */
export function assertAnalyticsRequests(requests) {
  for (const init of requests) {
    assert.equal(init.method, "POST");
    assert.equal(init.keepalive, true, "events must survive a following navigation");
    assert.equal(init.credentials, "include");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("X-CSRF-Token"), "csrf-test-token", "sent through the shared apiFetch with CSRF");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ["dimensions", "event"]);
  }
}
