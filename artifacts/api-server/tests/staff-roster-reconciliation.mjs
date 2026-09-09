const BASE = process.env.API_BASE || "http://localhost:8080/api";
let cookie = "";
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function main() {
  const suffix = Date.now();
  const email = `roster-reconcile-${suffix}@test.local`;
  const registered = await request("POST", "/auth/register", { name: "Roster Manager", email, password: "password-123" });
  check("register", registered.status === 200);
  check("verification token returned", typeof registered.data?.verificationToken === "string");
  check("verify", (await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);
  check("login", (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);

  const siteA = await request("POST", "/sites", { name: `Roster Site A ${suffix}` });
  const siteB = await request("POST", "/sites", { name: `Roster Site B ${suffix}` });
  check("create sites", siteA.status === 201 && siteB.status === 201);
  const alexEmail = `alex-${suffix}@test.local`;
  const alex = await request("POST", "/staff-roster", { name: "Alex Existing", email: alexEmail, siteId: siteA.data.id });
  check("create existing staff without payroll id", alex.status === 201);

  const firstRows = [
    { externalPayrollId: "EMP-001", name: "Alex Existing", email: alexEmail, jobTitle: "Chef", siteId: siteA.data.id },
    { externalPayrollId: "EMP-002", name: "Bob New", jobTitle: "Server", siteId: siteA.data.id },
  ];
  const preview = await request("POST", "/staff-roster/reconcile", { rows: firstRows, siteId: siteA.data.id, preview: true });
  check("preview succeeds without writing", preview.status === 200 && preview.data?.preview === true);
  check("preview adopts existing member and creates one", preview.data?.summary?.matchedByEmail === 1 && preview.data?.summary?.created === 1);
  const committed = await request("POST", "/staff-roster/reconcile", { rows: firstRows, siteId: siteA.data.id, preview: false });
  check("first replacement commits", committed.status === 200 && committed.data?.preview === false);
  let roster = await request("GET", "/staff-roster?includeInactive=true");
  const alexAfter = roster.data.find(row => row.external_payroll_id === "EMP-001");
  const bobAfter = roster.data.find(row => row.external_payroll_id === "EMP-002");
  check("existing internal id is preserved", alexAfter?.id === alex.data.id);
  check("new member is created", Number.isInteger(bobAfter?.id));

  const secondRows = [{ externalPayrollId: "EMP-001", name: "Alex Renamed", email: alexEmail, jobTitle: "Head Chef", siteId: siteA.data.id }];
  const second = await request("POST", "/staff-roster/reconcile", { rows: secondRows, siteId: siteA.data.id, preview: false });
  check("missing member is deactivated", second.status === 200 && second.data?.summary?.deactivated === 1);
  roster = await request("GET", "/staff-roster?includeInactive=true");
  check("current fields update on same person", roster.data.find(row => row.id === alex.data.id)?.name === "Alex Renamed");
  check("missing worker remains stored but inactive", roster.data.find(row => row.id === bobAfter.id)?.active === false);

  const returning = await request("POST", "/staff-roster/reconcile", {
    rows: [{ externalPayrollId: "emp-002", name: "Bob Returns", jobTitle: "Supervisor", siteId: siteA.data.id }],
    siteId: siteA.data.id,
    preview: false,
  });
  check("returning worker is reactivated", returning.status === 200 && returning.data?.summary?.reactivated === 1);
  roster = await request("GET", "/staff-roster?includeInactive=true");
  check("returning worker keeps internal id", roster.data.find(row => row.external_payroll_id === "EMP-002")?.id === bobAfter.id);

  const duplicate = await request("POST", "/staff-roster/reconcile", {
    rows: [
      { externalPayrollId: "DUP-1", name: "One", siteId: siteA.data.id },
      { externalPayrollId: "dup-1", name: "Two", siteId: siteA.data.id },
    ],
    siteId: siteA.data.id,
    preview: false,
  });
  check("duplicate identifiers are rejected", duplicate.status === 409);
  const conflictingSite = await request("POST", "/staff-roster/reconcile", {
    rows: [{ externalPayrollId: "SITE-1", name: "Wrong Site", siteId: siteB.data.id }],
    siteId: siteA.data.id,
    preview: false,
  });
  check("row cannot escape selected site scope", conflictingSite.status === 409);

  console.log(`${passed} checks passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});