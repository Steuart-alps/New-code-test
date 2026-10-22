// The AI features add-on (£25 a month, £15 of AI use a period), through the
// real API.
//
// Runs only through tests/run-fresh-schema.sh (disposable database). The suite
// bundles the app in-process with Stripe replaced by an in-memory fake
// (ai-addon-stripe.stub.ts) and Claude replaced by a local stand-in. Sessions,
// tenant checks, the ai_usage ledger and its per-business lock are real.
//
// Rules protected here:
//   - without the add-on (trials included) AI is refused before Claude is called;
//   - switching it on adds one £25 item per business and charges the first
//     month at once; a failed charge switches nothing on;
//   - the per-site quantity sync and the per-site price never include it;
//   - each request is priced from the tokens Claude reports and counted
//     against the add-on's current billing period only;
//   - once the allowance is used, AI is refused until the period renews, and
//     requests running together cannot all slip past it;
//   - a failed reading still counts what Claude charged; one turned away
//     before sending counts nothing;
//   - switching it off removes the item at once, with no proration.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.env.FRESH_SCHEMA_TEST !== "1" || !process.env.DATABASE_URL) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/ai-addon.mjs (disposable database only)");
}

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}${detail ? `: ${detail}` : ""}`); console.error(`FAIL: ${name}${detail ? `: ${detail}` : ""}`); }
}
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ── A stand-in for Claude: streams one JSON reply with fixed usage ─────────
let claudeRequests = 0;
let claudeReply = JSON.stringify({ appliances: [{ name: "Kettle", asset_tag: "PAT-1", appliance_type: "Kitchen Appliance", site_id: null, location: "Bar", notes: null, unclear: false }] });
let claudeDelayMs = 0;
const claude = createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    claudeRequests++;
    if (claudeDelayMs) await new Promise((resolve) => setTimeout(resolve, claudeDelayMs));
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1800, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: claudeReply } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 900 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
});
await new Promise((resolve) => claude.listen(0, "127.0.0.1", resolve));
// 1,800 input and 900 output tokens on Claude Opus 5.5 ($4 / $20 per million).
const READ_COST_MICROS = 1800 * 4 + 900 * 20;

process.env.SESSION_SECRET ||= "ai-addon-test-only-not-a-real-secret";
process.env.LOG_LEVEL ||= "error";
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
process.env.REGISTER_READING_MONTHLY_LIMIT = "0";
for (const name of ["AI_ADDON_PRICE_ID", "AI_MONTHLY_ALLOWANCE_PENCE", "AI_TRIAL_ALLOWANCE_PENCE", "AI_USD_TO_GBP", "REPORT_READING_MODEL"]) delete process.env[name];

function session(base) {
  let cookie = "";
  return async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function registerTenant(base, label, stamp) {
  const user = session(base);
  const email = `ai-addon-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `AI ${label}`, email, password: "password-123" });
  if (![200, 201].includes(registered.status)) throw new Error(`register ${label}: ${registered.status} ${JSON.stringify(registered.data)}`);
  await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  const login = await user("POST", "/auth/login", { email, password: "password-123" });
  if (login.status !== 200) throw new Error(`login ${label}: ${login.status} ${JSON.stringify(login.data)}`);
  const me = await user("GET", "/auth/me");
  const account = me.data?.user ?? me.data;
  if (!Number.isSafeInteger(account?.clientId)) throw new Error(`no client for ${label}`);
  return { user, clientId: account.clientId };
}

let t;
const query = async (text, params = []) => (await t.pool.query(text, params)).rows;
const usageRows = (clientId) =>
  query("SELECT feature, status, model, input_tokens, output_tokens, cost_usd_micros::int AS cost FROM ai_usage WHERE client_id = $1 ORDER BY id", [clientId]);
const stripeCalls = (method) => t.calls.filter((call) => call.method === method);
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
const readList = (user) => user("POST", "/imports/pat-appliances/read", { fileName: "list.jpg", mimeType: "image/jpeg", data: photo });

async function stripeMirror() {
  // A minimal copy of the synced Stripe tables the price lookups read.
  await query("CREATE SCHEMA IF NOT EXISTS stripe");
  await query("CREATE TABLE IF NOT EXISTS stripe.products (id text PRIMARY KEY, active boolean NOT NULL, name text)");
  await query(`CREATE TABLE IF NOT EXISTS stripe.prices (
    id text PRIMARY KEY, product text NOT NULL, active boolean NOT NULL, currency text, unit_amount integer,
    recurring jsonb, metadata jsonb, created integer)`);
  await query("INSERT INTO stripe.products (id, active, name) VALUES ('prod_ai', true, 'AI features') ON CONFLICT DO NOTHING");
  await query(`INSERT INTO stripe.prices (id, product, active, currency, unit_amount, recurring, metadata, created)
    VALUES ('price_ai', 'prod_ai', true, 'gbp', 2500, '{"interval":"month"}', '{"service_key":"ai"}', 1) ON CONFLICT DO NOTHING`);
  t.definePrice("price_ai", 2500, "ai");
  t.definePrice("price_core", 1000, "core");
  t.definePrice("price_pattrack", 1000, "pattrack");
}

async function main(base) {
  const stamp = Date.now();
  await stripeMirror();
  const tenant = await registerTenant(base, "a", stamp);
  const other = await registerTenant(base, "b", stamp);
  const { user, clientId } = tenant;
  const customer = `cus_ai_${clientId}`;
  const now = Math.floor(Date.now() / 1000);
  const periodStart = now - 10 * 86400;
  const periodEnd = now + 20 * 86400;

  console.log("\n── on a free trial, without the add-on ──");
  const trial = (await user("GET", "/billing/ai")).data;
  same("offered but not on", [trial?.configured, trial?.active, trial?.plan, trial?.purchasable, trial?.price], [true, false, "none", true, { unitAmount: 2500, currency: "gbp" }]);
  const status = (await user("GET", "/imports/pat-appliances/reading")).data;
  same("the PAT dialog sees the add-on is off", [status?.available, status?.ai?.active], [true, false]);
  const refused = await readList(user);
  same("reading refused without the add-on", [refused.status, refused.data?.code], [402, "AI_ADDON_REQUIRED"]);
  same("Claude was not called and nothing was counted", [claudeRequests, (await usageRows(clientId)).length], [0, 0]);
  same("cannot switch on without a subscription", (await user("POST", "/billing/ai", { action: "add" })).status, 400);

  console.log("\n── switching it on ──");
  await query("UPDATE clients SET stripe_customer_id = $1, trial_ends_at = now() - interval '1 day' WHERE id = $2", [customer, clientId]);
  t.setSubscription(customer, [{ serviceKey: "core", quantity: 3 }, { serviceKey: "pattrack", quantity: 3 }], periodStart, periodEnd);
  t.setInvoiceOutcome("open");
  const declined = await user("POST", "/billing/ai", { action: "add" });
  same("a declined first month switches nothing on", [declined.status, t.getSubscription(customer).items.data.some((item) => item.price.metadata.service_key === "ai")], [502, false]);
  t.setInvoiceOutcome("paid");
  t.calls.length = 0;
  const added = await user("POST", "/billing/ai", { action: "add" });
  same("switched on", [added.status, added.data?.active, added.data?.plan, added.data?.percentUsed], [200, true, "addon", 0]);
  const aiItems = t.getSubscription(customer).items.data.filter((item) => item.price.metadata.service_key === "ai");
  same("one item, quantity 1, whatever the sites", aiItems.map((item) => item.quantity), [1]);
  same("added with no proration", stripeCalls("subscriptions.update")[0]?.params?.proration_behavior, "none");
  same("first month charged at once: £25", stripeCalls("invoiceItems.create").map((call) => [call.params.amount, call.params.currency]), [[2500, "gbp"]]);
  same("switching on twice is refused", (await user("POST", "/billing/ai", { action: "add" })).status, 409);
  same("another business is unaffected", (await other.user("GET", "/billing/ai")).data?.plan, "none");

  console.log("\n── per-site billing leaves it alone ──");
  t.calls.length = 0;
  t.getSubscription(customer).items.data.find((item) => item.price.metadata.service_key === "core").quantity = 9;
  await t.syncClientSubscriptionQuantity(clientId);
  same("site sync never resizes the AI item", t.getSubscription(customer).items.data.find((item) => item.price.metadata.service_key === "ai")?.quantity, 1);
  const config = (await user("GET", "/billing/config")).data;
  same("not a per-site service in Settings", [config?.services?.perSiteRate, config?.services?.addons], [2000, ["pattrack"]]);

  console.log("\n── each reading is priced and counted ──");
  const read = await readList(user);
  same("reading works with the add-on", [read.status, read.data?.rows?.length], [200, 1]);
  same("ledger row from the tokens Claude reported",
    await usageRows(clientId),
    [{ feature: "register_reading", status: "done", model: "claude-opus-5-5", input_tokens: 1800, output_tokens: 900, cost: READ_COST_MICROS }]);
  const afterOne = (await user("GET", "/billing/ai")).data;
  same("a 2p reading is under 1% of £15", [afterOne?.percentUsed, afterOne?.usedUp, afterOne?.resetsAt], [0, false, new Date(periodEnd * 1000).toISOString()]);

  console.log("\n── the allowance runs out, and starts again with the period ──");
  // £15 at 80p a dollar is $18.75 of use.
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', 18750000)", [clientId]);
  const usedUp = (await user("GET", "/billing/ai")).data;
  same("shown as used up", [usedUp?.percentUsed, usedUp?.usedUp], [100, true]);
  const before = claudeRequests;
  const over = await readList(user);
  same("refused once used up", [over.status, over.data?.code], [429, "AI_ALLOWANCE_USED"]);
  check("says when it starts again", /starts again on/.test(over.data?.error ?? ""), over.data?.error);
  same("Claude not called when refused", claudeRequests, before);
  await query("UPDATE ai_usage SET created_at = to_timestamp($2) - interval '1 day' WHERE client_id = $1 AND cost_usd_micros = 18750000", [clientId, periodStart]);
  same("use from an earlier period does not count", (await readList(user)).status, 200);

  console.log("\n── requests running together cannot all slip past ──");
  // Leave about 1p of the allowance: the first request's 30p hold uses it.
  const spent = Number((await query("SELECT coalesce(sum(cost_usd_micros), 0)::bigint AS s FROM ai_usage WHERE client_id = $1 AND created_at >= to_timestamp($2)", [clientId, periodStart]))[0].s);
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', $2)", [clientId, 18750000 - 12500 - spent]);
  claudeDelayMs = 300;
  const together = await Promise.all([readList(user), readList(user), readList(user)]);
  claudeDelayMs = 0;
  same("exactly one goes ahead", together.map((result) => result.status).sort(), [200, 429, 429]);

  console.log("\n── failed readings ──");
  await query("DELETE FROM ai_usage WHERE client_id = $1", [clientId]);
  claudeReply = "not json";
  const failed = await readList(user);
  same("a reply that can't be understood fails", failed.status, 502);
  same("but what Claude charged still counts", (await usageRows(clientId)).map((row) => [row.status, row.cost]), [["failed", READ_COST_MICROS]]);
  claudeReply = JSON.stringify({ appliances: [{ name: "Kettle", asset_tag: null, appliance_type: "Other", site_id: null, location: null, notes: null, unclear: false }] });
  const unreadable = await user("POST", "/imports/pat-appliances/read", { fileName: "list.xlsx", mimeType: "application/vnd.ms-excel", data: photo });
  same("a file that can't be sent is turned away", unreadable.status, 400);
  same("and costs nothing", (await usageRows(clientId)).length, 1);

  console.log("\n── switching it off ──");
  t.calls.length = 0;
  const removed = await user("POST", "/billing/ai", { action: "remove" });
  same("switched off", [removed.status, removed.data?.active, removed.data?.plan], [200, false, "none"]);
  same("item removed at once, no proration", stripeCalls("subscriptionItems.del").map((call) => call.params?.proration_behavior), ["none"]);
  same("reading refused again", (await readList(user)).data?.code, "AI_ADDON_REQUIRED");
  same("switching off twice is refused", (await user("POST", "/billing/ai", { action: "remove" })).status, 409);
  same("another business without a subscription cannot switch on", (await other.user("POST", "/billing/ai", { action: "add" })).status, 400);
}

// ─── run ────────────────────────────────────────────────────────────────────

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-ai-addon-"));
let server;
try {
  const outfile = path.join(outDir, "entry.mjs");
  const stripeStub = path.join(dir, "ai-addon-stripe.stub.ts");
  await build({
    entryPoints: [path.join(dir, "ai-addon.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer", "stripe-replit-sync"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
    plugins: [{
      name: "stripe-client-stub",
      setup(builder) {
        builder.onResolve({ filter: /\/stripeClient$/ }, (args) =>
          args.importer.includes(`${path.sep}src${path.sep}`) ? { path: stripeStub } : undefined);
      },
    }],
  });
  t = await import(outfile);
  server = await t.startServer();
  await main(server.base);
} finally {
  if (server) await server.close();
  claude.close();
  await rm(outDir, { recursive: true, force: true });
}

console.log(`\nAI add-on: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
process.exit(0);
