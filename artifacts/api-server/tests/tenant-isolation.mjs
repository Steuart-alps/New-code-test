// Tenant-isolation integration tests.
//
// Registers two fresh accounts against a running API server and verifies that
// neither can read or modify the other's data — via direct resource IDs and
// via clientId spoofing in query strings and request bodies.
//
// Covers: core routes (sites, items, categories, contractors, certificates,
// clients, users, settings, billing) and service module routes (fire-safety,
// food-safety, legionella).
//
// Usage: node tests/tenant-isolation.mjs   (API must be running; default base
// http://localhost:8080/api, override with API_BASE env var)
// Exits 0 when every check passes, 1 otherwise.

const BASE = process.env.API_BASE || "http://localhost:8080/api";

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name} — ${detail}`);
    console.error(`FAIL: ${name} — ${detail}`);
  }
}

function makeSession() {
  let cookie = "";
  return async function request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) data = await res.json().catch(() => null);
    else await res.text().catch(() => null);
    return { status: res.status, data };
  };
}

function expectBlocked(name, status) {
  // Cross-tenant access must be rejected: forbidden, not-found, or a
  // validation rejection of the foreign ID. Never 2xx.
  check(name, [400, 403, 404].includes(status), `expected 400/403/404, got ${status}`);
}

function expectOk(name, status, allowed = [200, 201]) {
  check(name, allowed.includes(status), `expected ${allowed.join("/")}, got ${status}`);
}

// Unique date string to avoid food-safety recordDate collisions between tenants
function uniqueDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

async function setupTenant(label) {
  const req = makeSession();
  const email = `iso-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const reg = await req("POST", "/auth/register", {
    name: `Isolation ${label}`,
    email,
    password: "password-123",
  });
  expectOk(`${label}: register`, reg.status, [200, 201]);

  const me = await req("GET", "/auth/me");
  expectOk(`${label}: /auth/me`, me.status);
  const user = me.data?.user ?? me.data;
  const clientId = user?.clientId;
  check(`${label}: has clientId`, Number.isInteger(clientId), `clientId=${clientId}`);

  const site = await req("POST", "/sites", { name: `${label} HQ`, seedStarterChecks: true });
  expectOk(`${label}: create site`, site.status, [201]);

  const cats = await req("GET", "/categories");
  expectOk(`${label}: list categories`, cats.status);
  const items = await req("GET", "/compliance-items");
  expectOk(`${label}: list items`, items.status);
  const itemId = Array.isArray(items.data) ? items.data[0]?.id : items.data?.items?.[0]?.id;

  const contractor = await req("POST", "/contractors", { name: `${label} Contractor Ltd`, email: `contractor-${label}-${Date.now()}@test.local` });
  expectOk(`${label}: create contractor`, contractor.status, [201]);

  const itemCert = await req("POST", `/items/${itemId}/certificates`, { name: `${label} gas cert` });
  expectOk(`${label}: create item certificate`, itemCert.status, [201]);
  const contractorCert = await req("POST", `/contractors/${contractor.data?.id}/certificates`, { name: `${label} insurance cert` });
  expectOk(`${label}: create contractor certificate`, contractorCert.status, [201]);

  // ── Fire-safety module ───────────────────────────────────────────────────────
  // Trial accounts have "all" entitlements so module routes are always open.
  const fireSafetyCheck = await req("POST", "/fire-safety", {
    checkType: "alarm",
    checkDate: uniqueDate(),
    result: "pass",
  });
  expectOk(`${label}: create fire-safety check`, fireSafetyCheck.status, [201]);

  // ── Legionella module ────────────────────────────────────────────────────────
  const legionellaCheck = await req("POST", "/legionella", {
    checkType: "cold_water_temp",
    checkDate: uniqueDate(),
    result: "pass",
    temperature: 17.5,
  });
  expectOk(`${label}: create legionella check`, legionellaCheck.status, [201]);

  // ── Food-safety (KitchenTrack) module ────────────────────────────────────────
  const foodRecord = await req("POST", "/food-safety", {
    recordDate: uniqueDate(1), // yesterday to avoid same-day conflicts
  });
  expectOk(`${label}: create food-safety record`, foodRecord.status, [201]);

  return {
    req,
    label,
    clientId,
    userId: user?.id,
    siteId: site.data?.id,
    categoryId: cats.data?.[0]?.id,
    itemId,
    contractorId: contractor.data?.id,
    itemCertId: itemCert.data?.id,
    contractorCertId: contractorCert.data?.id,
    fireSafetyCheckId: fireSafetyCheck.data?.id,
    legionellaCheckId: legionellaCheck.data?.id,
    foodRecordId: foodRecord.data?.id,
  };
}

async function attack(attacker, victim) {
  const { req } = attacker;
  const tag = `${attacker.label}→${victim.label}`;

  // ── Direct resource-ID access: core routes ───────────────────────────────────
  expectBlocked(`${tag}: GET /sites/:id`, (await req("GET", `/sites/${victim.siteId}`)).status);
  expectBlocked(`${tag}: PATCH /sites/:id`, (await req("PATCH", `/sites/${victim.siteId}`, { name: "hacked" })).status);
  expectBlocked(`${tag}: DELETE /sites/:id`, (await req("DELETE", `/sites/${victim.siteId}`)).status);

  expectBlocked(`${tag}: GET /compliance-items/:id`, (await req("GET", `/compliance-items/${victim.itemId}`)).status);
  expectBlocked(`${tag}: PUT /compliance-items/:id`, (await req("PUT", `/compliance-items/${victim.itemId}`, { name: "hacked" })).status);
  expectBlocked(`${tag}: PATCH /compliance-items/:id/status`, (await req("PATCH", `/compliance-items/${victim.itemId}/status`, { status: "compliant" })).status);
  expectBlocked(`${tag}: DELETE /compliance-items/:id`, (await req("DELETE", `/compliance-items/${victim.itemId}`)).status);

  expectBlocked(`${tag}: GET /categories/:id`, (await req("GET", `/categories/${victim.categoryId}`)).status);
  expectBlocked(`${tag}: PATCH /categories/:id`, (await req("PATCH", `/categories/${victim.categoryId}`, { name: "hacked" })).status);
  expectBlocked(`${tag}: DELETE /categories/:id`, (await req("DELETE", `/categories/${victim.categoryId}`)).status);

  expectBlocked(`${tag}: GET /items/:itemId/certificates`, (await req("GET", `/items/${victim.itemId}/certificates`)).status);
  expectBlocked(`${tag}: POST /items/:itemId/certificates`, (await req("POST", `/items/${victim.itemId}/certificates`, { name: "hacked.pdf" })).status);
  expectBlocked(`${tag}: PUT /items/:itemId/certificates/:id`, (await req("PUT", `/items/${victim.itemId}/certificates/${victim.itemCertId}`, { name: "hacked" })).status);
  expectBlocked(`${tag}: DELETE /items/:itemId/certificates/:id`, (await req("DELETE", `/items/${victim.itemId}/certificates/${victim.itemCertId}`)).status);

  expectBlocked(`${tag}: GET /contractors/:id`, (await req("GET", `/contractors/${victim.contractorId}`)).status);
  expectBlocked(`${tag}: PUT /contractors/:id`, (await req("PUT", `/contractors/${victim.contractorId}`, { name: "hacked" })).status);
  expectBlocked(`${tag}: DELETE /contractors/:id`, (await req("DELETE", `/contractors/${victim.contractorId}`)).status);

  expectBlocked(`${tag}: GET /contractors/:id/certificates`, (await req("GET", `/contractors/${victim.contractorId}/certificates`)).status);
  expectBlocked(`${tag}: POST /contractors/:id/certificates`, (await req("POST", `/contractors/${victim.contractorId}/certificates`, { name: "hacked.pdf" })).status);
  expectBlocked(`${tag}: PUT /contractors/:id/certificates/:certId`, (await req("PUT", `/contractors/${victim.contractorId}/certificates/${victim.contractorCertId}`, { name: "hacked" })).status);
  expectBlocked(`${tag}: DELETE /contractors/:id/certificates/:certId`, (await req("DELETE", `/contractors/${victim.contractorId}/certificates/${victim.contractorCertId}`)).status);

  expectBlocked(`${tag}: GET /clients/:id`, (await req("GET", `/clients/${victim.clientId}`)).status);
  expectBlocked(`${tag}: PUT /clients/:id`, (await req("PUT", `/clients/${victim.clientId}`, { name: "hacked" })).status);
  expectBlocked(`${tag}: DELETE /clients/:id`, (await req("DELETE", `/clients/${victim.clientId}`)).status);

  expectBlocked(`${tag}: PUT /users/:id (victim owner)`, (await req("PUT", `/users/${victim.userId}`, { name: "hacked" })).status);
  expectBlocked(`${tag}: DELETE /users/:id (victim owner)`, (await req("DELETE", `/users/${victim.userId}`)).status);

  // ── clientId spoofing via query string: core ─────────────────────────────────
  for (const path of [
    `/sites?clientId=${victim.clientId}`,
    `/compliance-items?clientId=${victim.clientId}`,
    `/categories?clientId=${victim.clientId}`,
    `/users?clientId=${victim.clientId}`,
    `/settings?clientId=${victim.clientId}`,
    `/dashboard/stats?clientId=${victim.clientId}`,
    `/billing/config?clientId=${victim.clientId}`,
  ]) {
    expectBlocked(`${tag}: GET ${path.split("?")[0]}?clientId=victim`, (await req("GET", path)).status);
  }

  // ── clientId spoofing via request body: core ─────────────────────────────────
  expectBlocked(`${tag}: POST /sites body clientId`, (await req("POST", "/sites", { name: "sneaky", clientId: victim.clientId })).status);
  expectBlocked(`${tag}: POST /compliance-items body clientId`, (await req("POST", "/compliance-items", { name: "sneaky", clientId: victim.clientId })).status);
  expectBlocked(`${tag}: POST /categories body clientId`, (await req("POST", "/categories", { name: "sneaky", clientId: victim.clientId })).status);
  expectBlocked(`${tag}: POST /users body clientId`, (await req("POST", "/users", { name: "sneaky", email: `sneak-${Date.now()}@test.local`, password: "password-123", role: "staff", clientId: victim.clientId })).status);
  expectBlocked(`${tag}: PUT /settings body clientId`, (await req("PUT", `/settings?clientId=${victim.clientId}`, { companyName: "hacked" })).status);

  // ── Billing: no cross-tenant checkout / portal / invoice access ───────────────
  expectBlocked(`${tag}: POST /billing/checkout victim clientId`, (await req("POST", "/billing/checkout", { clientId: victim.clientId })).status);
  expectBlocked(`${tag}: POST /billing/portal?clientId=victim`, (await req("POST", `/billing/portal?clientId=${victim.clientId}`)).status);
  expectBlocked(`${tag}: GET /billing/invoices?clientId=victim`, (await req("GET", `/billing/invoices?clientId=${victim.clientId}`)).status);
  expectBlocked(`${tag}: GET /contractors?clientId=victim`, (await req("GET", `/contractors?clientId=${victim.clientId}`)).status);

  // ── Cross-tenant references inside own-tenant creates ────────────────────────
  expectBlocked(`${tag}: POST /compliance-items with victim siteId`, (await req("POST", "/compliance-items", { name: "sneaky", siteId: victim.siteId })).status);
  expectBlocked(`${tag}: POST /compliance-items with victim categoryId`, (await req("POST", "/compliance-items", { name: "sneaky", categoryId: victim.categoryId })).status);

  // ── FireTrack: direct record access ─────────────────────────────────────────
  expectBlocked(
    `${tag}: PUT /fire-safety/:id`,
    (await req("PUT", `/fire-safety/${victim.fireSafetyCheckId}`, { result: "fail" })).status,
  );
  expectBlocked(
    `${tag}: DELETE /fire-safety/:id`,
    (await req("DELETE", `/fire-safety/${victim.fireSafetyCheckId}`)).status,
  );

  // FireTrack: clientId spoofing via query string
  expectBlocked(
    `${tag}: GET /fire-safety?clientId=victim`,
    (await req("GET", `/fire-safety?clientId=${victim.clientId}`)).status,
  );
  expectBlocked(
    `${tag}: GET /fire-safety/status?clientId=victim`,
    (await req("GET", `/fire-safety/status?clientId=${victim.clientId}`)).status,
  );

  // FireTrack: clientId spoofing via request body
  expectBlocked(
    `${tag}: POST /fire-safety body clientId`,
    (await req("POST", "/fire-safety", {
      checkType: "alarm",
      checkDate: uniqueDate(2),
      result: "pass",
      clientId: victim.clientId,
    })).status,
  );

  // FireTrack: list scoping — victim record must not appear
  const fireSafetyList = await req("GET", "/fire-safety");
  expectOk(`${tag}: GET /fire-safety own list`, fireSafetyList.status);
  check(
    `${tag}: /fire-safety excludes victim record`,
    !((Array.isArray(fireSafetyList.data) ? fireSafetyList.data : []).some(
      (r) => r.id === victim.fireSafetyCheckId,
    )),
    "victim fire-safety check visible in list",
  );

  // ── LegionellaTrack: direct record access ────────────────────────────────────
  expectBlocked(
    `${tag}: PUT /legionella/:id`,
    (await req("PUT", `/legionella/${victim.legionellaCheckId}`, { result: "fail" })).status,
  );
  expectBlocked(
    `${tag}: DELETE /legionella/:id`,
    (await req("DELETE", `/legionella/${victim.legionellaCheckId}`)).status,
  );

  // LegionellaTrack: clientId spoofing via query string
  expectBlocked(
    `${tag}: GET /legionella?clientId=victim`,
    (await req("GET", `/legionella?clientId=${victim.clientId}`)).status,
  );
  expectBlocked(
    `${tag}: GET /legionella/status?clientId=victim`,
    (await req("GET", `/legionella/status?clientId=${victim.clientId}`)).status,
  );

  // LegionellaTrack: clientId spoofing via request body
  expectBlocked(
    `${tag}: POST /legionella body clientId`,
    (await req("POST", "/legionella", {
      checkType: "sentinel_flush",
      checkDate: uniqueDate(2),
      result: "pass",
      clientId: victim.clientId,
    })).status,
  );

  // LegionellaTrack: list scoping — victim record must not appear
  const legionellaList = await req("GET", "/legionella");
  expectOk(`${tag}: GET /legionella own list`, legionellaList.status);
  check(
    `${tag}: /legionella excludes victim record`,
    !((Array.isArray(legionellaList.data) ? legionellaList.data : []).some(
      (r) => r.id === victim.legionellaCheckId,
    )),
    "victim legionella check visible in list",
  );

  // ── KitchenTrack (food-safety): direct record access ────────────────────────
  expectBlocked(
    `${tag}: PUT /food-safety/:id`,
    (await req("PUT", `/food-safety/${victim.foodRecordId}`, { correctives: "hacked" })).status,
  );

  // KitchenTrack: clientId spoofing via query string
  expectBlocked(
    `${tag}: GET /food-safety?clientId=victim`,
    (await req("GET", `/food-safety?clientId=${victim.clientId}`)).status,
  );
  expectBlocked(
    `${tag}: GET /food-safety/config?clientId=victim`,
    (await req("GET", `/food-safety/config?clientId=${victim.clientId}`)).status,
  );

  // KitchenTrack: clientId spoofing via request body
  expectBlocked(
    `${tag}: POST /food-safety body clientId`,
    (await req("POST", "/food-safety", {
      recordDate: uniqueDate(3),
      clientId: victim.clientId,
    })).status,
  );
  expectBlocked(
    `${tag}: PUT /food-safety/config body clientId`,
    (await req("PUT", `/food-safety/config?clientId=${victim.clientId}`, {
      food_num_fridges: "99",
    })).status,
  );

  // KitchenTrack: list scoping — victim record must not appear
  const foodList = await req("GET", "/food-safety");
  expectOk(`${tag}: GET /food-safety own list`, foodList.status);
  check(
    `${tag}: /food-safety excludes victim record`,
    !((Array.isArray(foodList.data) ? foodList.data : []).some(
      (r) => r.id === victim.foodRecordId,
    )),
    "victim food-safety record visible in list",
  );

  // ── List scoping: core routes ────────────────────────────────────────────────
  const clients = await req("GET", "/clients");
  expectOk(`${tag}: GET /clients`, clients.status);
  check(
    `${tag}: /clients excludes victim`,
    !((Array.isArray(clients.data) ? clients.data : []).some((c) => c.id === victim.clientId)),
    "victim client visible in list",
  );

  const users = await req("GET", "/users");
  expectOk(`${tag}: GET /users`, users.status);
  check(
    `${tag}: /users excludes victim owner`,
    !((Array.isArray(users.data) ? users.data : []).some((u) => u.id === victim.userId)),
    "victim user visible in list",
  );

  const sites = await req("GET", "/sites");
  expectOk(`${tag}: GET /sites`, sites.status);
  check(
    `${tag}: /sites excludes victim site`,
    !((Array.isArray(sites.data) ? sites.data : []).some((s) => s.id === victim.siteId)),
    "victim site visible in list",
  );

  const items = await req("GET", "/compliance-items");
  expectOk(`${tag}: GET /compliance-items`, items.status);
  const itemArr = Array.isArray(items.data) ? items.data : items.data?.items ?? [];
  check(
    `${tag}: /compliance-items excludes victim item`,
    !itemArr.some((i) => i.id === victim.itemId),
    "victim item visible in list",
  );
}

async function main() {
  // Unauthenticated requests must be rejected outright.
  const anon = makeSession();
  for (const path of [
    "/sites",
    "/compliance-items",
    "/users",
    "/settings",
    "/clients",
    "/billing/invoices",
    "/fire-safety",
    "/fire-safety/status",
    "/legionella",
    "/legionella/status",
    "/food-safety",
    "/food-safety/config",
  ]) {
    const { status } = await anon("GET", path);
    check(`anon: GET ${path}`, status === 401, `expected 401, got ${status}`);
  }

  const a = await setupTenant("A");
  const b = await setupTenant("B");

  check("setup: A ids resolved", a.siteId && a.itemId && a.categoryId && a.clientId, JSON.stringify({ siteId: a.siteId, itemId: a.itemId, categoryId: a.categoryId, clientId: a.clientId }));
  check("setup: B ids resolved", b.siteId && b.itemId && b.categoryId && b.clientId, JSON.stringify({ siteId: b.siteId, itemId: b.itemId, categoryId: b.categoryId, clientId: b.clientId }));
  check("setup: A module records", a.fireSafetyCheckId && a.legionellaCheckId && a.foodRecordId, JSON.stringify({ fireSafetyCheckId: a.fireSafetyCheckId, legionellaCheckId: a.legionellaCheckId, foodRecordId: a.foodRecordId }));
  check("setup: B module records", b.fireSafetyCheckId && b.legionellaCheckId && b.foodRecordId, JSON.stringify({ fireSafetyCheckId: b.fireSafetyCheckId, legionellaCheckId: b.legionellaCheckId, foodRecordId: b.foodRecordId }));

  await attack(b, a);
  await attack(a, b);

  // Cleanup: each tenant deletes its own site (also exercises the happy path).
  expectOk("A: delete own site", (await a.req("DELETE", `/sites/${a.siteId}`)).status, [204]);
  expectOk("B: delete own site", (await b.req("DELETE", `/sites/${b.siteId}`)).status, [204]);

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
