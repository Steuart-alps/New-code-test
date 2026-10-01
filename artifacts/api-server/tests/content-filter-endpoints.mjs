// Run through test:content-filter: the harness owns a disposable DB and API.
// Test real HTTP routes, auth, validation and persistence, not a mocked filter.
import assert from "node:assert/strict";
import test from "node:test";

const base = process.env.API_BASE;
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1" || !base
    || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  throw new Error("Use test:content-filter with the disposable local API harness.");
}

const unsafeCases = [
  { name: "case-insensitive profanity", value: "SHIT maintenance", error: "Please use an appropriate name." },
  { name: "HTML script", value: "<script>alert(1)</script>", error: "This name contains invalid characters or code." },
  { name: "HTML event handler", value: "onerror=alert(1)", error: "This name contains invalid characters or code." },
  { name: "JavaScript protocol", value: "JaVaScRiPt :alert(1)", error: "This name contains invalid characters or code." },
  { name: "SQL statement", value: "Acme'; DROP TABLE contractors; --", error: "This name contains invalid characters or code." },
  { name: "SQL union", value: "Acme UNION SELECT name", error: "This name contains invalid characters or code." },
];

test("contractor and compliance content-filter endpoint contracts", async (t) => {
  let cookie = "";
  async function request(method, path, body) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const sessionCookie = response.headers.get("set-cookie");
    if (sessionCookie) cookie = sessionCookie.split(";")[0];
    assert.match(response.headers.get("content-type") ?? "", /application\/json/, `${method} ${path} must return JSON`);
    return { status: response.status, data: await response.json() };
  }
  function expectStatus(response, status, label) {
    assert.equal(response.status, status, `${label} returned unexpected HTTP status`);
  }

  const stamp = Date.now();
  const email = `content-filter-${stamp}@test.local`;
  const password = "fixture-password-123";
  const registered = await request("POST", "/auth/register", { name: "Content Filter Manager", email, password });
  expectStatus(registered, 200, "Register test manager");
  assert.equal(typeof registered.data.verificationToken, "string");
  expectStatus(await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`),
    200, "Verify test manager");
  expectStatus(await request("POST", "/auth/login", { email, password }), 200, "Sign in test manager");

  const site = await request("POST", "/sites", { name: "Content Filter Site", seedStarterChecks: false });
  expectStatus(site, 201, "Create fixture site");
  assert.ok(Number.isInteger(site.data.id));

  const contractorBody = {
    name: "Scunthorpe Electrical Services",
    company: "O'Connor & Sons",
    email: `contractor-${stamp}@test.local`,
  };
  const complianceBody = {
    title: "Penistone fire-safety inspection",
    notes: "Inspect Scunthorpe's east-wing sockets; record 5 < 10 readings.",
    siteId: site.data.id,
    dueDate: "2099-12-31",
  };

  const contractor = await request("POST", "/contractors", contractorBody);
  expectStatus(contractor, 201, "Clean contractor creation");
  assert.ok(Number.isInteger(contractor.data.id));
  assert.equal(contractor.data.name, contractorBody.name);
  const item = await request("POST", "/compliance-items", complianceBody);
  expectStatus(item, 201, "Clean compliance creation");
  assert.ok(Number.isInteger(item.data.id));
  assert.equal(item.data.title, complianceBody.title);
  assert.equal(item.data.notes, complianceBody.notes);

  const fields = [
    { path: "/contractors", id: contractor.data.id, body: contractorBody, field: "name" },
    { path: "/compliance-items", id: item.data.id, body: complianceBody, field: "title" },
    { path: "/compliance-items", id: item.data.id, body: complianceBody, field: "notes" },
  ];
  for (const target of fields) {
    for (const method of ["POST", "PUT"]) {
      for (const unsafe of unsafeCases) {
        await t.test(`${method} ${target.path} rejects ${unsafe.name} in ${target.field}`, async () => {
          const beforeRecord = await request("GET", `${target.path}/${target.id}`);
          expectStatus(beforeRecord, 200, "Read baseline record");
          // Other fields remain valid: a schema/auth failure must not count as
          // proof that the content-filter guard was reached.
          const body = method === "PUT" && target.path === "/compliance-items"
            ? { [target.field]: unsafe.value }
            : { ...target.body, [target.field]: unsafe.value };
          const rejected = await request(method,
            method === "PUT" ? `${target.path}/${target.id}` : target.path, body);
          expectStatus(rejected, 400, "Unsafe content");
          // Literal contract: do not derive expected text from filterName,
          // which would let a broken validator and a broken test agree.
          assert.deepEqual(rejected.data, { error: unsafe.error });
          const afterRecord = await request("GET", `${target.path}/${target.id}`);
          expectStatus(afterRecord, 200, "Read record after rejection");
          assert.deepEqual(afterRecord.data, beforeRecord.data, "Rejected write must not alter a saved record");
        });
      }
    }
  }

  await t.test("clean contractor update preserves punctuation and word boundaries", async () => {
    const body = { ...contractorBody, name: "Penistone & Scunthorpe Maintenance", company: "O'Connor (UK) Ltd" };
    const updated = await request("PUT", `/contractors/${contractor.data.id}`, body);
    expectStatus(updated, 200, "Clean contractor update");
    assert.equal(updated.data.name, body.name);
    assert.equal(updated.data.company, body.company);
    const saved = await request("GET", `/contractors/${contractor.data.id}`);
    expectStatus(saved, 200, "Read clean contractor update");
    assert.equal(saved.data.name, body.name);
    assert.equal(saved.data.company, body.company);
  });
  await t.test("clean compliance title and notes update successfully", async () => {
    const body = {
      title: "Scunthorpe annual electrical inspection",
      notes: "O'Connor & Sons will inspect Penistone's sockets (5 < 10 readings).",
    };
    const updated = await request("PUT", `/compliance-items/${item.data.id}`, body);
    expectStatus(updated, 200, "Clean compliance update");
    assert.equal(updated.data.title, body.title);
    assert.equal(updated.data.notes, body.notes);
    const saved = await request("GET", `/compliance-items/${item.data.id}`);
    expectStatus(saved, 200, "Read clean compliance update");
    assert.equal(saved.data.title, body.title);
    assert.equal(saved.data.notes, body.notes);
  });
  for (const notes of ["", null]) {
    await t.test(`compliance notes can be cleared to ${notes === null ? "null" : "empty text"}`, async () => {
      const updated = await request("PUT", `/compliance-items/${item.data.id}`, { notes });
      expectStatus(updated, 200, "Clear compliance notes");
      assert.equal(updated.data.notes, notes);
    });
  }
});