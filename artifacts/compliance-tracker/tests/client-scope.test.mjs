// The generated API client must send the selected business (clientId) on
// writes as well as reads, otherwise a consultant working in another business
// writes into their home one. A clientId the caller chose must win, and with no
// getter registered (the mobile app) URLs must be left untouched.
import assert from "node:assert/strict";
import {
  appendClientId,
  callerChoseClientId,
  customFetch,
  setClientIdGetter,
} from "../../../lib/api-client-react/src/custom-fetch.ts";

const sent = [];
globalThis.fetch = async (input, init) => {
  sent.push({ url: typeof input === "string" ? input : input.url, method: init?.method });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};

async function urlFor(path, init) {
  sent.length = 0;
  await customFetch(path, init);
  assert.equal(sent.length, 1);
  return sent[0].url;
}

// No getter (mobile): unchanged for every method.
setClientIdGetter(null);
assert.equal(await urlFor("/api/sites"), "/api/sites");
assert.equal(await urlFor("/api/sites", { method: "POST", body: "{}" }), "/api/sites");

setClientIdGetter(() => 42);
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
  const init = method === "GET" || method === "DELETE" ? { method } : { method, body: JSON.stringify({ name: "x" }) };
  assert.equal(await urlFor("/api/sites", init), "/api/sites?clientId=42", `${method} carries the selected business`);
}
assert.equal(await urlFor("/api/sites?siteId=3", { method: "POST", body: "{}" }), "/api/sites?siteId=3&clientId=42");

// The caller's own choice wins: query or JSON body.
assert.equal(await urlFor("/api/users?clientId=7"), "/api/users?clientId=7");
assert.equal(await urlFor("/api/users?clientId=7", { method: "POST", body: "{}" }), "/api/users?clientId=7");
assert.equal(
  await urlFor("/api/users", { method: "POST", body: JSON.stringify({ clientId: 7, email: "a@b.c" }) }),
  "/api/users",
);

// A business is selected only when the getter returns one.
setClientIdGetter(() => null);
assert.equal(await urlFor("/api/sites", { method: "POST", body: "{}" }), "/api/sites");
setClientIdGetter(null);

// Helpers shared with the web app's hand-written fetches.
assert.equal(callerChoseClientId("/x?clientId=1", undefined), true);
assert.equal(callerChoseClientId("/x?client=1", undefined), false);
assert.equal(callerChoseClientId("/x", "{\"clientId\":null}"), true);
assert.equal(callerChoseClientId("/x", "[1,2]"), false);
assert.equal(callerChoseClientId("/x", "not json"), false);
assert.equal(appendClientId("/x#frag", 5), "/x?clientId=5#frag");
assert.equal(appendClientId("https://h/x?a=1", 5), "https://h/x?a=1&clientId=5");

console.log("Client scope tests passed.");
