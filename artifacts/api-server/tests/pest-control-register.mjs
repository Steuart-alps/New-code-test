import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.API_BASE || "http://localhost:8080/api";

function extractPdfText(pdf) {
  const dir = mkdtempSync(join(tmpdir(), "pest-register-"));
  const pdfPath = join(dir, "register.pdf");
  const textPath = join(dir, "register.txt");
  writeFileSync(pdfPath, pdf);
  execFileSync("pdftotext", [pdfPath, textPath]);
  const text = readFileSync(textPath, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return text;
}

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
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

async function createManager() {
  const request = session();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `pest-register-${stamp}@test.local`;
  const registration = await request("POST", "/auth/register", {
    name: "Pest Register Manager",
    email,
    password: "password-123",
  });
  assert.ok([200, 201].includes(registration.status));
  assert.ok(registration.data.verificationToken);
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registration.data.verificationToken)}`)).status, 200);
  assert.equal((await request("POST", "/auth/login", { email, password: "password-123" })).status, 200);
  return { request, stamp };
}

const { request, stamp } = await createManager();
const ownVisit = await request("POST", "/pest-track/visits", {
  visitDate: "2026-08-01",
  contractorName: "Wrong Tenant Contractor",
  areasInspected: "Wrong tenant area",
});
assert.equal(ownVisit.status, 201);

const client = await request("POST", "/clients", {
  name: `Selected Café Business ${stamp}`,
  slug: `selected-pest-${stamp}`,
});
assert.ok([200, 201].includes(client.status));
const selectedClientId = client.data.id;

const emptyPdf = await request("GET", `/pest-track/register.pdf?clientId=${selectedClientId}`);
assert.equal(emptyPdf.status, 200);
assert.equal(emptyPdf.contentType, "application/pdf");
assert.match(extractPdfText(emptyPdf.data), /Contractor visits \(0\)/);

for (let index = 0; index < 26; index += 1) {
  const visit = await request("POST", `/pest-track/visits?clientId=${selectedClientId}`, {
    visitDate: `2026-08-${String((index % 26) + 1).padStart(2, "0")}`,
    contractorName: index === 0 ? "Café Контроль Вредителей" : `Contractor ${index}`,
    contractorCompany: "Inspection Company",
    areasInspected: "Kitchen, cellar and external bin store",
    findings: `Representative long finding ${"full evidence ".repeat(20)}TRAILING-EVIDENCE-MARKER`,
    treatmentsApplied: "Bait stations checked and replenished",
    recommendations: "Seal the gap below the rear door",
    nextVisitDate: "2026-11-01",
    signedOffBy: "Site Manager",
    notes: index === 0 ? "Visit note: vollständig geprüft — πλήρης έλεγχος" : null,
  });
  assert.equal(visit.status, 201);
}

const activity = await request("POST", `/pest-track/activity?clientId=${selectedClientId}`, {
  recordedDate: "2026-08-15",
  pestType: "rodent",
  evidenceType: "droppings",
  location: "Dry store",
  severity: "high",
  actionTaken: "Isolated stock and called contractor",
  recordedBy: "Shift Manager",
  resolved: true,
  notes: "Activity note: suivi terminé — проверка завершена",
});
assert.equal(activity.status, 201);

const pdf = await request("GET", `/pest-track/register.pdf?clientId=${selectedClientId}`);
assert.equal(pdf.status, 200);
assert.equal(pdf.contentType, "application/pdf");
assert.match(pdf.disposition, /pest-control-register-\d{4}-\d{2}-\d{2}\.pdf/);
assert.match(pdf.data.subarray(0, 8).toString("ascii"), /^%PDF-1\.[3-7]$/);
const text = extractPdfText(pdf.data);
assert.ok(pdf.data.length > 10_000);
assert.match(text, /Selected Café Business/);
assert.match(text, /Contractor visits \(26\)/);
assert.match(text, /Café Контроль Вредителей/);
assert.match(text, /Kitchen, cellar and external bin store/);
assert.match(text, /TRAILING-EVIDENCE-MARKER/);
assert.match(text, /Bait stations checked and replenished/);
assert.match(text, /Seal the gap below the rear door/);
assert.match(text, /Next visit: 2026-11-01/);
assert.match(text, /Signed off by: Site Manager/);
assert.match(text, /Visit note: vollständig geprüft — πλήρης έλεγχος/);
assert.match(text, /Dry store/);
assert.match(text, /Isolated stock and called contractor/);
assert.match(text, /Shift Manager/);
assert.match(text, /Activity note: suivi terminé — проверка завершена/);
assert.match(text, /Resolved/);
assert.doesNotMatch(text, /Wrong Tenant Contractor|Wrong tenant area/);

console.log("Pest control register export tests passed.");