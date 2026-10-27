// The AI features add-on (£15 a month, £10 of AI use a period, £6 top-ups for
// £4 more), through the
// real API.
//
// Runs only through tests/run-fresh-schema.sh (disposable database). The suite
// bundles the app in-process with Stripe replaced by an in-memory fake
// (ai-addon-stripe.stub.ts) and Claude replaced by a local stand-in. Sessions,
// tenant checks, the ai_usage ledger and its per-business lock are real.
//
// Rules protected here:
//   - without the add-on (trials included) AI is refused before Claude is called;
//   - switching it on adds one £15 item per business and charges the first
//     month at once; a failed charge switches nothing on;
//   - the per-site quantity sync and the per-site price never include it;
//   - each request is priced from the tokens Claude reports and counted
//     against the add-on's current billing period only;
//   - once the allowance is used, AI is refused until the period renews, and
//     requests running together cannot all slip past it;
//   - a failed reading still counts what Claude charged; one turned away
//     before sending counts nothing;
//   - a top-up is charged at once and adds its use until renewal; a declined
//     one adds nothing, and the same request id never charges twice;
//   - automatic top-ups (the owner's choice) buy one when the allowance runs
//     out, once for requests running together, up to the monthly limit, and
//     not again for a day after a declined charge;
//   - switching it off removes the item at once, with no proration;
//   - a business with no trial end (every module free, set up by ALPS) gets
//     the monthly allowance free each calendar month; its owner may agree to a
//     top-up, which ALPS invoices (no Stripe charge), and a repeat adds one;
//   - owners are warned once when 75% of a period's allowance is used.
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
for (const name of ["AI_ADDON_PRICE_ID", "AI_MONTHLY_ALLOWANCE_PENCE", "AI_TRIAL_ALLOWANCE_PENCE", "AI_USD_TO_GBP", "REPORT_READING_MODEL", "AI_TOP_UP_PRICE_PENCE", "AI_TOP_UP_ALLOWANCE_PENCE", "AI_AUTO_TOP_UP_LIMIT"]) delete process.env[name];

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
    VALUES ('price_ai', 'prod_ai', true, 'gbp', 1500, '{"interval":"month"}', '{"service_key":"ai"}', 1) ON CONFLICT DO NOTHING`);
  t.definePrice("price_ai", 1500, "ai");
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
  same("offered but not on", [trial?.configured, trial?.active, trial?.plan, trial?.purchasable, trial?.price], [true, false, "none", true, { unitAmount: 1500, currency: "gbp" }]);
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
  same("first month charged at once: £15", stripeCalls("invoiceItems.create").map((call) => [call.params.amount, call.params.currency]), [[1500, "gbp"]]);
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
  same("a 2p reading is under 1% of £10", [afterOne?.percentUsed, afterOne?.usedUp, afterOne?.resetsAt], [0, false, new Date(periodEnd * 1000).toISOString()]);

  console.log("\n── the allowance runs out, and starts again with the period ──");
  // £10 at 80p a dollar is $12.50 of use.
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', 12500000)", [clientId]);
  const usedUp = (await user("GET", "/billing/ai")).data;
  same("shown as used up", [usedUp?.percentUsed, usedUp?.usedUp], [100, true]);
  const before = claudeRequests;
  const over = await readList(user);
  same("refused once used up", [over.status, over.data?.code], [429, "AI_ALLOWANCE_USED"]);
  check("says when it starts again", /starts again on/.test(over.data?.error ?? ""), over.data?.error);
  same("Claude not called when refused", claudeRequests, before);
  check("and says a top-up is possible", /buy a top-up/.test(over.data?.error ?? ""), over.data?.error);

  console.log("\n── buying a top-up ──");
  same("top-up offered at £6 for £4, none bought yet, automatic off",
    [usedUp?.topUp, usedUp?.topUpsThisPeriod, usedUp?.autoTopUp, usedUp?.autoTopUpLimit],
    [{ amount: 600, allowance: 400, currency: "gbp" }, 0, false, 3]);
  same("a top-up needs a request id", (await user("POST", "/billing/ai", { action: "top_up" })).status, 400);
  t.setInvoiceOutcome("open");
  const declinedTopUp = await user("POST", "/billing/ai", { action: "top_up", requestId: crypto.randomUUID() });
  same("a declined top-up adds nothing", [declinedTopUp.status, (await user("GET", "/billing/ai")).data?.usedUp], [502, true]);
  t.setInvoiceOutcome("paid");
  t.calls.length = 0;
  const requestId = crypto.randomUUID();
  const topped = await user("POST", "/billing/ai", { action: "top_up", requestId });
  same("top-up bought", [topped.status, topped.data?.usedUp, topped.data?.topUpsThisPeriod, topped.data?.percentUsed], [200, false, 1, 72]);
  same("charged £6 at once", stripeCalls("invoiceItems.create").map((call) => [call.params.amount, call.params.currency]), [[600, "gbp"]]);
  same("the same request never charges twice", [(await user("POST", "/billing/ai", { action: "top_up", requestId })).status, stripeCalls("invoiceItems.create").length], [200, 1]);
  same("reading works again", (await readList(user)).status, 200);
  same("another business has no top-ups", (await other.user("GET", "/billing/ai")).data?.topUpsThisPeriod, 0);

  console.log("\n── automatic top-ups ──");
  // Use up the top-up too: £4 is $5.
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', 5000000)", [clientId]);
  same("used up again", (await readList(user)).status, 429);
  const autoOn = await user("POST", "/billing/ai", { action: "auto_top_up", enabled: true });
  same("owner switches automatic top-ups on", [autoOn.status, autoOn.data?.autoTopUp], [200, true]);
  same("another business is unaffected", (await other.user("GET", "/billing/ai")).data?.autoTopUp, false);
  const autoRows = async () => (await query("SELECT status FROM ai_top_ups WHERE client_id = $1 AND automatic ORDER BY id", [clientId])).map((row) => row.status);
  same("an automatic top-up is bought and the reading goes ahead", [(await readList(user)).status, await autoRows()], [200, ["paid"]]);
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', 5000000)", [clientId]);
  claudeDelayMs = 300;
  const autoTogether = await Promise.all([readList(user), readList(user), readList(user)]);
  claudeDelayMs = 0;
  same("requests running together buy only one", [autoTogether.map((result) => result.status), await autoRows()], [[200, 200, 200], ["paid", "paid"]]);
  process.env.AI_AUTO_TOP_UP_LIMIT = "2";
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', 5000000)", [clientId]);
  same("no more than the monthly limit", [(await readList(user)).status, (await autoRows()).length], [429, 2]);
  delete process.env.AI_AUTO_TOP_UP_LIMIT;
  t.setInvoiceOutcome("open");
  same("a declined automatic top-up adds nothing", [(await readList(user)).status, await autoRows()], [429, ["paid", "paid", "failed"]]);
  t.setInvoiceOutcome("paid");
  same("and is not tried again for a day", [(await readList(user)).status, (await autoRows()).length], [429, 3]);
  same("switched off again", (await user("POST", "/billing/ai", { action: "auto_top_up", enabled: false })).data?.autoTopUp, false);

  await query("UPDATE ai_usage SET created_at = to_timestamp($2) - interval '1 day' WHERE client_id = $1", [clientId, periodStart]);
  await query("UPDATE ai_top_ups SET created_at = to_timestamp($2) - interval '1 day' WHERE client_id = $1", [clientId, periodStart]);
  same("use and top-ups from an earlier period do not count", [(await readList(user)).status, (await user("GET", "/billing/ai")).data?.topUpsThisPeriod], [200, 0]);

  console.log("\n── requests running together cannot all slip past ──");
  // Leave about 1p of the allowance: the first request's 30p hold uses it.
  const spent = Number((await query("SELECT coalesce(sum(cost_usd_micros), 0)::bigint AS s FROM ai_usage WHERE client_id = $1 AND created_at >= to_timestamp($2)", [clientId, periodStart]))[0].s);
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', $2)", [clientId, 12500000 - 12500 - spent]);
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
  same("no top-ups without the add-on", [(await user("POST", "/billing/ai", { action: "top_up", requestId: crypto.randomUUID() })).status, (await user("GET", "/billing/ai")).data?.topUp], [409, null]);
  same("another business without a subscription cannot switch on", (await other.user("POST", "/billing/ai", { action: "add" })).status, 400);

  console.log("\n── a business free with no end date has it included ──");
  const free = await registerTenant(base, "free", stamp);
  await query("UPDATE clients SET trial_ends_at = NULL WHERE id = $1", [free.clientId]);
  const monthEnd = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();
  const included = (await free.user("GET", "/billing/ai")).data;
  same("included, renewing at the start of next month, top-ups invoiced by ALPS",
    [included?.active, included?.plan, included?.percentUsed, included?.resetsAt, included?.topUp],
    [true, "included", 0, monthEnd, { amount: 600, allowance: 400, currency: "gbp" }]);
  const freeRead = await readList(free.user);
  same("reading works with no subscription", [freeRead.status, (await usageRows(free.clientId)).length], [200, 1]);
  // Last month's use does not count against this month.
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros, created_at) VALUES ($1, 'report_reading', 'done', 12500000, date_trunc('month', now()) - interval '1 day')", [free.clientId]);
  same("last month's use is not counted", (await free.user("GET", "/billing/ai")).data?.usedUp, false);
  same("no warning below 75%", await t.warnIfAllowanceNearlyUsed(free.clientId), false);
  // £8 of £10 ($10 at 80p a dollar): past the 75% warning.
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', 10000000)", [free.clientId]);
  same("warned once at 75% used", [await t.warnIfAllowanceNearlyUsed(free.clientId), await t.warnIfAllowanceNearlyUsed(free.clientId)], [true, false]);
  same("the warning is recorded as sent",
    (await query("SELECT count(*)::int AS n FROM scheduled_email_claims WHERE job = 'ai-allowance-warning' AND sent_at IS NOT NULL AND delivery_key LIKE $1", [`${free.clientId}:%`]))[0]?.n, 1);
  await query("INSERT INTO ai_usage (client_id, feature, status, cost_usd_micros) VALUES ($1, 'report_reading', 'done', 2500000)", [free.clientId]);
  const freeOver = await readList(free.user);
  same("refused once this month's allowance is used", [freeOver.status, freeOver.data?.code], [429, "AI_ALLOWANCE_USED"]);
  check("says when it starts again and that an owner can agree to a top-up",
    /starts again on/.test(freeOver.data?.error ?? "") && /agree to a top-up/.test(freeOver.data?.error ?? ""), freeOver.data?.error);
  const freeRequest = crypto.randomUUID();
  t.calls.length = 0;
  const freeTopUp = await free.user("POST", "/billing/ai", { action: "top_up", requestId: freeRequest });
  same("the owner agrees to a top-up", [freeTopUp.status, freeTopUp.data?.topUpsThisPeriod, freeTopUp.data?.usedUp], [200, 1, false]);
  same("nothing is charged in Stripe", t.calls.length, 0);
  same("recorded at the normal price for ALPS to invoice", await query("SELECT amount_pence, allowance_pence, status FROM ai_top_ups WHERE client_id = $1", [free.clientId]),
    [{ amount_pence: 600, allowance_pence: 400, status: "paid" }]);
  same("the same request adds nothing more", (await free.user("POST", "/billing/ai", { action: "top_up", requestId: freeRequest })).data?.topUpsThisPeriod, 1);
  same("reading works again after the top-up", (await readList(free.user)).status, 200);
  same("no new warning until 75% of the bigger allowance", await t.warnIfAllowanceNearlyUsed(free.clientId), false);
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
