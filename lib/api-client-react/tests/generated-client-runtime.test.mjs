import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Runtime check that the Orval-generated client still works through
// customFetch after a regeneration: base URL, auth/client/CSRF headers,
// request options, JSON bodies and success/error parsing. Type checks alone
// cannot catch a generator change that, say, drops the method or stops
// forwarding request options. fetch is stubbed; no API server is needed.

// The generated files import "../custom-fetch" without an extension, as the
// bundlers expect. Let Node resolve those to the .ts source.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // fall through to the default resolution
      }
    }
    return nextResolve(specifier, context);
  },
});

// The package entry point, exactly as the web and mobile apps import it.
const api = await import("../src/index.ts");

const sent = [];
const queued = [];
globalThis.fetch = async (input, init = {}) => {
  sent.push({
    url: String(input),
    method: init.method,
    headers: new Headers(init.headers),
    body: init.body,
    credentials: init.credentials,
    signal: init.signal,
  });
  const next = queued.shift();
  assert.ok(next, `unexpected request: ${init.method} ${String(input)}`);
  return next();
};

const respond = (status, body, contentType = "application/json", statusText = "") => {
  queued.push(() => new Response(
    body === null ? null : typeof body === "string" ? body : JSON.stringify(body),
    { status, statusText, headers: contentType ? { "content-type": contentType } : {} },
  ));
};

function reset() {
  sent.length = 0;
  queued.length = 0;
  api.setBaseUrl(null);
  api.setAuthTokenGetter(null);
  api.setClientIdGetter(null);
  api.setCsrfTokenProvider(null);
  api.setUnauthorizedHandler(null);
  api.setPaymentRequiredHandler(null);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("query: generated queryFn sends GET with base URL, bearer token, client scope and signal", async () => {
  api.setBaseUrl("https://api.example.test/");
  api.setAuthTokenGetter(async () => "mobile-token");
  api.setClientIdGetter(() => 7);
  const entries = [{ id: 1, module: "fire", action: "create" }];
  respond(200, entries, "application/json; charset=utf-8");

  const options = api.getListAuditLogQueryOptions({ module: "fire" });
  assert.deepEqual(options.queryKey, ["/api/audit-log", { module: "fire" }]);

  const controller = new AbortController();
  const result = await options.queryFn({ signal: controller.signal, queryKey: options.queryKey, meta: undefined });

  assert.deepEqual(result, entries, "JSON body is parsed");
  const [request] = sent;
  assert.equal(request.url, "https://api.example.test/api/audit-log?module=fire&clientId=7");
  assert.equal(request.method, "GET");
  assert.equal(request.headers.get("authorization"), "Bearer mobile-token");
  assert.equal(request.credentials, "include");
  assert.equal(request.signal, controller.signal, "React Query's abort signal reaches fetch");
  assert.equal(request.body, undefined);
});

test("query: relative URL is kept when no base URL is set (web app)", async () => {
  respond(200, { id: 3, name: "Fire" });

  const category = await api.getCategory(3);

  assert.deepEqual(category, { id: 3, name: "Fire" });
  assert.equal(sent[0].url, "/api/categories/3");
  assert.equal(sent[0].headers.has("authorization"), false, "no token getter: no Authorization header");
});

test("query: request options from the hook reach customFetch", async () => {
  api.setBaseUrl("https://api.example.test/base");
  respond(200, "plain text body", "text/plain");

  const options = api.getListCategoriesQueryOptions({
    request: { headers: { "X-Request-Source": "runtime-test" }, responseType: "text" },
  });
  const result = await options.queryFn({ signal: new AbortController().signal, queryKey: options.queryKey, meta: undefined });

  assert.equal(result, "plain text body");
  assert.equal(sent[0].url, "https://api.example.test/base/api/categories");
  assert.equal(sent[0].headers.get("x-request-source"), "runtime-test");
});

test("mutation: generated mutationFn POSTs a JSON body with CSRF token and caller headers", async () => {
  api.setClientIdGetter(() => 7);
  api.setCsrfTokenProvider({ get: () => "csrf-token", reset: () => {} });
  respond(201, { id: 11, name: "Water", color: "#0af" });

  const options = api.getCreateCategoryMutationOptions({ request: { headers: { "X-Request-Source": "runtime-test" } } });
  assert.deepEqual(options.mutationKey, ["createCategory"]);
  const created = await options.mutationFn({ data: { name: "Water", color: "#0af" } });

  assert.deepEqual(created, { id: 11, name: "Water", color: "#0af" });
  const [request] = sent;
  assert.equal(request.url, "/api/categories?clientId=7");
  assert.equal(request.method, "POST");
  assert.deepEqual(JSON.parse(request.body), { name: "Water", color: "#0af" });
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.equal(request.headers.get("x-csrf-token"), "csrf-token");
  assert.equal(request.headers.get("x-request-source"), "runtime-test");
});

test("mutation: path id, body and an explicit clientId param pass through PATCH", async () => {
  api.setClientIdGetter(() => 7);
  respond(200, { id: 5, status: "resolved", revision: 3 });

  const options = api.getUpdateFeedbackReportMutationOptions();
  const updated = await options.mutationFn({
    id: 5,
    data: { expectedRevision: 2, status: "resolved" },
    params: { clientId: 9 },
  });

  assert.deepEqual(updated, { id: 5, status: "resolved", revision: 3 });
  assert.equal(sent[0].url, "/api/feedback/5?clientId=9", "the caller's clientId wins over the selected business");
  assert.equal(sent[0].method, "PATCH");
  assert.deepEqual(JSON.parse(sent[0].body), { expectedRevision: 2, status: "resolved" });
});

test("mutation: DELETE with 204 resolves to null", async () => {
  respond(204, null, null);

  const result = await api.getDeleteCategoryMutationOptions().mutationFn({ id: 4 });

  assert.equal(result, null);
  assert.equal(sent[0].url, "/api/categories/4");
  assert.equal(sent[0].method, "DELETE");
  assert.equal(sent[0].body, undefined);
});

test("error: problem+json 409 becomes an ApiError with parsed data", async () => {
  respond(409, { title: "Conflict", detail: "Report changed since you opened it", currentRevision: 4 },
    "application/problem+json", "Conflict");

  await assert.rejects(
    api.updateFeedbackReport(5, { expectedRevision: 2 }),
    (error) => {
      assert.equal(error.name, "ApiError");
      assert.equal(error.status, 409);
      assert.equal(error.method, "PATCH");
      assert.equal(error.url, "/api/feedback/5");
      assert.deepEqual(error.data, { title: "Conflict", detail: "Report changed since you opened it", currentRevision: 4 });
      assert.equal(error.message, "HTTP 409 Conflict: Conflict — Report changed since you opened it");
      return true;
    },
  );
});

test("error: 401 and 402 call the app handlers; HTML error pages are summarised", async () => {
  let unauthorized = 0;
  let paymentRequired = 0;
  api.setUnauthorizedHandler(() => { unauthorized += 1; });
  api.setPaymentRequiredHandler(() => { paymentRequired += 1; });

  respond(401, { error: "Not signed in" }, "application/json", "Unauthorized");
  await assert.rejects(api.listCategories(), { name: "ApiError", status: 401, message: "HTTP 401 Unauthorized: Not signed in" });
  assert.equal(unauthorized, 1);

  respond(402, { error: "Trial ended" }, "application/json", "Payment Required");
  await assert.rejects(api.listCategories(), { status: 402 });
  assert.equal(paymentRequired, 1);

  respond(502, "<!doctype html><html><head><title>Bad Gateway</title></head><body></body></html>", "text/html", "Bad Gateway");
  await assert.rejects(api.getCategory(1), { status: 502, message: "HTTP 502 Bad Gateway: Bad Gateway", data: "<!doctype html><html><head><title>Bad Gateway</title></head><body></body></html>" });
});

test("error: a malformed JSON success body raises ResponseParseError", async () => {
  respond(200, "{not json", "application/json", "OK");

  await assert.rejects(api.getCategory(2), (error) => {
    assert.equal(error.name, "ResponseParseError");
    assert.equal(error.rawBody, "{not json");
    assert.match(error.message, /GET \/api\/categories\/2 \(200 OK\) as JSON/);
    return true;
  });
});

let failed = 0;
for (const { name, fn } of tests) {
  reset();
  try {
    await fn();
    assert.equal(queued.length, 0, "every queued response was used");
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}\n${error?.stack ?? error}`);
  }
}

if (failed > 0) {
  console.error(`${failed} of ${tests.length} generated client runtime tests failed.`);
  process.exit(1);
}
console.log(`Generated API client runtime tests passed (${tests.length}).`);
