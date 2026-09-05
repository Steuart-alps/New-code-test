import assert from "node:assert/strict";

const BASE = process.env.API_BASE || "http://localhost:8080/api";

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const contentType = response.headers.get("content-type") ?? "";
    let data;
    if (contentType.includes("application/json")) data = await response.json();
    else if (contentType.includes("application/pdf")) data = Buffer.from(await response.arrayBuffer());
    else data = await response.text();
    return { status: response.status, contentType, disposition: response.headers.get("content-disposition"), data };
  };
}

async function createTenant(label) {
  const request = session();
  const email = `bike-export-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const registration = await request("POST", "/auth/register", {
    name: `Bike Export ${label}`,
    email,
    password: "password-123",
  });
  assert.ok([200, 201].includes(registration.status));
  assert.ok(registration.data.verificationToken);
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registration.data.verificationToken)}`)).status, 200);
  assert.equal((await request("POST", "/auth/login", { email, password: "password-123" })).status, 200);
  return request;
}

async function createHire(request, suffix, hireDate, values = {}) {
  const bike = await request("POST", "/bike-track/bikes", {
    ref: values.bikeRef ?? `BIKE-${suffix}`,
    type: "hybrid",
  });
  assert.equal(bike.status, 201);
  const hire = await request("POST", "/bike-track/hires", {
    bikeId: bike.data.id,
    guestName: values.guestName ?? `Guest ${suffix}`,
    guestContact: values.guestContact ?? `guest-${suffix}@test.local`,
    hireDate,
    depositPence: 2500,
    notes: values.notes ?? `Notes ${suffix}`,
    preHireCheck: { overallResult: "pass", checkDate: hireDate },
  });
  assert.equal(hire.status, 201);
}

const managerA = await createTenant("a");
const managerB = await createTenant("b");

await createHire(managerA, "before", "2026-07-31");
await createHire(managerA, "from", "2026-08-01", {
  guestName: "=HYPERLINK(\"https://example.invalid\",\"click\")",
  guestContact: "\t@SUM(1+1)",
  bikeRef: "+CMD",
  notes: "-2+3",
});
await createHire(managerA, "to", "2026-08-31");
await createHire(managerA, "after", "2026-09-01");
await createHire(managerB, "other-tenant", "2026-08-15", { guestName: "Other tenant secret" });

const csv = await managerA("GET", "/bike-track/hires/export?from=2026-08-01&to=2026-08-31&format=csv");
assert.equal(csv.status, 200);
assert.match(csv.contentType, /^text\/csv/);
assert.match(csv.disposition, /bike-hire-register-2026-08-01-to-2026-08-31\.csv/);
assert.match(csv.data, /"'\+CMD"/);
assert.match(csv.data, /Guest to/);
assert.doesNotMatch(csv.data, /Guest before|Guest after|Other tenant secret/);
assert.match(csv.data, /"'=HYPERLINK/);
assert.match(csv.data, /"'\t@SUM/);
assert.match(csv.data, /"'-2\+3"/);

const pdf = await managerA("GET", "/bike-track/hires/export?from=2026-08-01&to=2026-08-31&format=pdf");
assert.equal(pdf.status, 200);
assert.equal(pdf.contentType, "application/pdf");
assert.match(pdf.disposition, /bike-hire-register-2026-08-01-to-2026-08-31\.pdf/);
assert.equal(pdf.data.subarray(0, 8).toString("ascii"), "%PDF-1.4");
assert.match(pdf.data.toString("ascii"), /Guest to/);
assert.doesNotMatch(pdf.data.toString("ascii"), /Other tenant secret/);

const reversed = await managerA("GET", "/bike-track/hires/export?from=2026-08-31&to=2026-08-01&format=csv");
assert.equal(reversed.status, 400);

console.log("Bike hire register export tests passed.");