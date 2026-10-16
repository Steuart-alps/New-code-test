import assert from "node:assert/strict";
import { ApiError, customFetch, setOverrideReasonHandler } from "../src/custom-fetch.ts";

// An owner changing a record older than its correction window gets 423
// OVERRIDE_REASON_REQUIRED. The client asks for a reason once and resends the
// same request with X-Override-Reason; a cancelled prompt keeps the 423.

const sent = [];
let responses = [];
globalThis.fetch = async (input, init) => {
  sent.push({ url: String(input), method: init.method, body: init.body, headers: new Headers(init.headers) });
  const [status, body] = responses.shift() ?? [200, { ok: true }];
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};
const reasonRequired = [423, {
  error: "This record is more than a day old. Add a reason to change it.",
  code: "OVERRIDE_REASON_REQUIRED",
  cutoffDate: "2026-10-14",
}];
const staffLocked = [423, { error: "This record is locked", code: "TRACK_RECORD_LOCKED" }];

const asked = [];
let answer = "Logged against the wrong fridge";
setOverrideReasonHandler(async (info) => {
  asked.push(info);
  return answer;
});

// A reason resends the same request once, URI-encoded.
answer = "Logged against the wrong fridge — fixed";
sent.length = 0;
responses = [reasonRequired, [200, { id: 7 }]];
const result = await customFetch("/api/fire-safety/7", { method: "PUT", body: '{"notes":"x"}' });
assert.deepEqual(result, { id: 7 });
assert.equal(sent.length, 2);
assert.equal(sent[0].headers.has("x-override-reason"), false);
assert.equal(sent[1].headers.get("x-override-reason"), encodeURIComponent(answer));
assert.equal(sent[1].body, '{"notes":"x"}');
assert.equal(sent[1].method, "PUT");
assert.deepEqual(asked.at(-1), {
  method: "PUT",
  url: "/api/fire-safety/7",
  message: "This record is more than a day old. Add a reason to change it.",
});

// Cancelling keeps the original 423 and sends nothing more.
answer = null;
sent.length = 0;
responses = [reasonRequired];
await assert.rejects(customFetch("/api/fire-safety/7", { method: "DELETE" }), (error) => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 423);
  assert.equal(error.data.code, "OVERRIDE_REASON_REQUIRED");
  return true;
});
assert.equal(sent.length, 1);

// Only once: a second 423 is the caller's error.
answer = "Still trying";
sent.length = 0;
responses = [reasonRequired, reasonRequired];
await assert.rejects(customFetch("/api/fire-safety/7", { method: "PUT", body: "{}" }), (error) => error.status === 423);
assert.equal(sent.length, 2);

// Staff locks and reads never prompt.
const before = asked.length;
sent.length = 0;
responses = [staffLocked];
await assert.rejects(customFetch("/api/fire-safety/7", { method: "PUT", body: "{}" }), (error) => error.data.code === "TRACK_RECORD_LOCKED");
responses = [reasonRequired];
await assert.rejects(customFetch("/api/fire-safety/7"), (error) => error.status === 423);
assert.equal(asked.length, before);
assert.equal(sent.length, 2);

// A body that cannot be replayed (a stream) is not retried.
sent.length = 0;
responses = [reasonRequired];
const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } });
await assert.rejects(customFetch("/api/fire-safety/7", { method: "PUT", body: stream, duplex: "half" }), (error) => error.status === 423);
assert.equal(sent.length, 1);
assert.equal(asked.length, before);

// No handler (mobile): the 423 comes straight back.
setOverrideReasonHandler(null);
sent.length = 0;
responses = [reasonRequired];
await assert.rejects(customFetch("/api/fire-safety/7", { method: "PUT", body: "{}" }), (error) => error.status === 423);
assert.equal(sent.length, 1);

console.log("customFetch override-reason retry tests passed.");
