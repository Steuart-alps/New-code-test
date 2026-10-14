import assert from "node:assert/strict";
import {
  customFetch,
  setAuthTokenGetter,
  setCsrfTokenProvider,
} from "../src/custom-fetch.ts";

// Regression for the missing-CSRF-token bug: cookie-authenticated mutations
// from the generated client must carry X-CSRF-Token, while reads and
// bearer-authenticated (mobile) requests must not.

const sent = [];
let nextStatus = 200;
globalThis.fetch = async (input, init) => {
  sent.push({ url: String(input), method: init.method, headers: new Headers(init.headers) });
  const status = nextStatus;
  nextStatus = 200;
  return new Response(status === 200 ? '{"ok":true}' : '{"error":"CSRF validation failed"}', {
    status,
    headers: { "content-type": "application/json" },
  });
};

let tokenRequests = 0;
let resets = 0;
const provider = {
  get: async () => {
    tokenRequests += 1;
    return "session-csrf-token";
  },
  reset: () => {
    resets += 1;
  },
};

async function lastRequest(url, options) {
  await customFetch(url, options);
  return sent.at(-1);
}

// No provider registered: nothing is added.
assert.equal((await lastRequest("/api/sites", { method: "POST", body: "{}" })).headers.has("x-csrf-token"), false,
  "no provider: no token header");

setCsrfTokenProvider(provider);

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  const request = await lastRequest("/api/sites/1", { method, body: method === "DELETE" ? undefined : "{}" });
  assert.equal(request.headers.get("x-csrf-token"), "session-csrf-token", `${method} carries the token`);
}

const get = await lastRequest("/api/sites");
assert.equal(get.headers.has("x-csrf-token"), false, "GET does not carry the token");
const lowerGet = await lastRequest("/api/sites", { method: "get" });
assert.equal(lowerGet.headers.has("x-csrf-token"), false, "lower-case get does not carry the token");

const before = tokenRequests;
const explicitBearer = await lastRequest("/api/sites", {
  method: "POST",
  body: "{}",
  headers: { Authorization: "Bearer mobile-token" },
});
assert.equal(explicitBearer.headers.has("x-csrf-token"), false, "explicit Authorization header is exempt");
assert.equal(tokenRequests, before, "the token is not even fetched for bearer requests");

setAuthTokenGetter(() => "mobile-token");
const getterBearer = await lastRequest("/api/sites", { method: "POST", body: "{}" });
assert.equal(getterBearer.headers.get("authorization"), "Bearer mobile-token");
assert.equal(getterBearer.headers.has("x-csrf-token"), false, "bearer from the auth getter is exempt");
setAuthTokenGetter(null);

// A rejected mutation drops the cached token so the next one fetches a fresh one.
nextStatus = 403;
await assert.rejects(customFetch("/api/sites", { method: "POST", body: "{}" }), { status: 403 });
assert.equal(resets, 1, "403 on a token-carrying mutation resets the provider");

setCsrfTokenProvider(null);
assert.equal((await lastRequest("/api/sites", { method: "POST", body: "{}" })).headers.has("x-csrf-token"), false,
  "cleared provider: no token header");

console.log("customFetch CSRF header tests passed.");
