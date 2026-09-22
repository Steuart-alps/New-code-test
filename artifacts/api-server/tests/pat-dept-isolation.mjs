import { writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}: ${detail}`);
    console.error(`FAIL: ${name}: ${detail}`);
  }
}
function expectStatus(name, response, expected) {
  check(name, expected.includes(response.status), `expected ${expected.join("/")}, got ${response.status}`);
}
function session() {
  let cookie = "";
  const request = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (response.headers.get("content-type") || "").includes("application/json")
      ? await response.json().catch(() => null) : null;
    return { status: response.status, data };
  };
  request.cookie = () => cookie;
  return request;
}

async function main() {
  const stamp = Date.now();
  const fixtureDate = new Date().toISOString().slice(0, 10);
  const admin = session();
  const email = `pat-dept-admin-${stamp}@test.local`;
  const registered = await admin("POST", "/auth/register", {
    name: "PAT department admin", email, password: "password-123",
  });
  expectStatus("register admin", registered, [200, 201]);
  check("test server exposes verification token", typeof registered.data?.verificationToken === "string");
  if (typeof registered.data?.verificationToken !== "string") throw new Error("Verification token unavailable; run via the test runner");
  expectStatus("verify admin", await admin("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
  expectStatus("login admin", await admin("POST", "/auth/login", { email, password: "password-123" }), [200]);
  const me = await admin("GET", "/auth/me");
  const clientId = (me.data?.user ?? me.data)?.clientId;
  check("admin has client", Number.isInteger(clientId), String(clientId));

  const alphaDept = await admin("POST", "/departments", { name: `PAT Alpha ${stamp}` });
  const betaDept = await admin("POST", "/departments", { name: `PAT Beta ${stamp}` });
  const alphaSite = await admin("POST", "/sites", { name: `PAT Alpha ${stamp}`, departmentId: alphaDept.data?.id, seedStarterChecks: false });
  const betaSite = await admin("POST", "/sites", { name: `PAT Beta ${stamp}`, departmentId: betaDept.data?.id, seedStarterChecks: false });
  for (const [name, response] of [["alpha department", alphaDept], ["beta department", betaDept], ["alpha site", alphaSite], ["beta site", betaSite]]) {
    expectStatus(`create ${name}`, response, [200, 201]);
  }
  const alphaTemplate = await admin("POST", "/pat-track/equipment-templates", { siteId: alphaSite.data.id, name: "Alpha template" });
  const betaTemplate = await admin("POST", "/pat-track/equipment-templates", { siteId: betaSite.data.id, name: "Beta template" });
  const alphaRoom = await admin("POST", "/pat-track/rooms", { siteId: alphaSite.data.id, templateId: alphaTemplate.data.id, name: "Alpha room" });
  const betaRoom = await admin("POST", "/pat-track/rooms", { siteId: betaSite.data.id, templateId: betaTemplate.data.id, name: "Beta room" });
  const certificateBody = (siteId, roomId, ref) => ({
    siteId, roomIds: [roomId], visitDate: fixtureDate, certificateRef: ref,
  });
  const alphaCertificate = await admin("POST", "/pat-track/certificates", certificateBody(alphaSite.data.id, alphaRoom.data.id, "ALPHA-CERT"));
  const betaCertificate = await admin("POST", "/pat-track/certificates", certificateBody(betaSite.data.id, betaRoom.data.id, "BETA-CERT"));
  expectStatus("reject javascript certificate document link", await admin("POST", "/pat-track/certificates", {
    ...certificateBody(alphaSite.data.id, alphaRoom.data.id, "BAD-JS-LINK"),
    documentLink: "javascript:alert(1)",
  }), [400]);
  expectStatus("reject data certificate document link", await admin("POST", "/pat-track/certificates", {
    ...certificateBody(alphaSite.data.id, alphaRoom.data.id, "BAD-DATA-LINK"),
    documentLink: "data:text/html,<script>alert(1)</script>",
  }), [400]);
  const betaReplacement = await admin("POST", "/pat-track/replacements", {
    roomId: betaRoom.data.id, applianceName: "Kettle", replacedOn: "2025-01-11",
  });
  const betaFailure = await admin("POST", "/pat-track/failures", {
    certificateId: betaCertificate.data.id, roomId: betaRoom.data.id, applianceName: "Lamp",
  });
  // Legacy appliance/test register records must obey exactly the same boundary.
  const alphaAppliance = await admin("POST", "/pat-track/appliances", {
    siteId: alphaSite.data.id, name: "Alpha kettle",
  });
  const betaAppliance = await admin("POST", "/pat-track/appliances", {
    siteId: betaSite.data.id, name: "Beta kettle",
  });
  const alphaTest = await admin("POST", "/pat-track/tests", {
    applianceId: alphaAppliance.data.id, testDate: fixtureDate, result: "pass",
  });
  const betaTest = await admin("POST", "/pat-track/tests", {
    applianceId: betaAppliance.data.id, testDate: fixtureDate, result: "pass",
  });
  for (const [name, response] of [
    ["alpha template", alphaTemplate], ["beta template", betaTemplate], ["alpha room", alphaRoom],
    ["beta room", betaRoom], ["alpha certificate", alphaCertificate], ["beta certificate", betaCertificate],
    ["beta replacement", betaReplacement], ["beta failure", betaFailure], ["alpha legacy appliance", alphaAppliance],
    ["beta legacy appliance", betaAppliance], ["alpha legacy test", alphaTest], ["beta legacy test", betaTest],
  ]) expectStatus(`admin creates ${name}`, response, [201]);

  const staffEmail = `pat-dept-staff-${stamp}@test.local`;
  expectStatus("create alpha staff", await admin("POST", "/users", {
    name: "PAT Alpha staff", email: staffEmail, password: "password-456",
    role: "client_staff", clientId, departmentId: alphaDept.data.id,
  }), [200, 201]);
  const staff = session();
  expectStatus("login alpha staff", await staff("POST", "/auth/login", {
    email: staffEmail, password: "password-456",
  }), [200]);
  expectStatus("department staff cannot read shared PAT config", await staff("GET", "/pat-track/config"), [403]);
  expectStatus("department staff cannot update shared PAT config", await staff("PUT", "/pat-track/config", {
    pat_default_tester: "Forbidden",
  }), [403]);
  expectStatus("department staff cannot read shared PAT presets", await staff("GET", "/pat-track/preset-templates"), [403]);
  expectStatus("department staff cannot update shared PAT presets", await staff("PUT", "/pat-track/preset-templates/hotel-suite", {
    items: [{ name: "Forbidden", type: "Other" }],
  }), [403]);
  expectStatus("department staff cannot delete shared PAT presets", await staff("DELETE", "/pat-track/preset-templates/hotel-suite"), [403]);

  for (const [path, hiddenId] of [
    ["/pat-track/equipment-templates", betaTemplate.data.id],
    ["/pat-track/rooms", betaRoom.data.id],
    ["/pat-track/certificates", betaCertificate.data.id],
    ["/pat-track/replacements", betaReplacement.data.id],
    ["/pat-track/failures", betaFailure.data.id],
  ]) {
    const listed = await staff("GET", path);
    expectStatus(`list ${path}`, listed, [200]);
    check(`${path} hides beta record`, Array.isArray(listed.data) && !listed.data.some(row => row.id === hiddenId));
  }
  const legacyAppliances = await staff("GET", "/pat-track/appliances");
  expectStatus("list legacy appliances", legacyAppliances, [200]);
  check("legacy appliance list hides beta", Array.isArray(legacyAppliances.data) && !legacyAppliances.data.some(row => row.id === betaAppliance.data.id));
  const legacyTests = await staff("GET", "/pat-track/tests");
  expectStatus("list legacy tests", legacyTests, [200]);
  check("legacy test list hides beta", Array.isArray(legacyTests.data) && !legacyTests.data.some(row => row.id === betaTest.data.id));
  const status = await staff("GET", "/pat-track/status");
  expectStatus("legacy status", status, [200]);
  check("legacy status excludes beta appliance", status.data?.totalAppliances === 1, `total=${status.data?.totalAppliances}`);
  for (const path of ["/pat-track/rooms", "/pat-track/certificates", "/pat-track/failures", "/pat-track/replacements"]) {
    expectStatus(`${path} rejects beta site filter`, await staff("GET", `${path}?siteId=${betaSite.data.id}`), [403]);
  }
  expectStatus("legacy appliances reject beta site filter", await staff("GET", `/pat-track/appliances?siteId=${betaSite.data.id}`), [403]);
  expectStatus("legacy tests reject beta appliance filter", await staff("GET", `/pat-track/tests?applianceId=${betaAppliance.data.id}`), [403]);

  expectStatus("cannot create room at beta site", await staff("POST", "/pat-track/rooms", {
    siteId: betaSite.data.id, templateId: betaTemplate.data.id, name: "Forbidden room",
  }), [403]);
  expectStatus("cannot create legacy appliance at beta site", await staff("POST", "/pat-track/appliances", {
    siteId: betaSite.data.id, name: "Forbidden appliance",
  }), [403]);
  expectStatus("cannot create legacy test for beta appliance", await staff("POST", "/pat-track/tests", {
    applianceId: betaAppliance.data.id, testDate: fixtureDate, result: "pass",
  }), [403]);
  expectStatus("cannot link replacement to beta room", await staff("POST", "/pat-track/replacements", {
    roomId: betaRoom.data.id, applianceName: "Forbidden", replacedOn: "2025-01-12",
  }), [403]);
  expectStatus("cannot link certificate to beta room", await staff("POST", "/pat-track/certificates",
    certificateBody(betaSite.data.id, betaRoom.data.id, "FORBIDDEN-CERT")), [403]);
  expectStatus("cannot link failure to beta certificate", await staff("POST", "/pat-track/failures", {
    certificateId: betaCertificate.data.id, roomId: betaRoom.data.id, applianceName: "Forbidden",
  }), [403]);

  expectStatus("cannot update beta room", await staff("PUT", `/pat-track/rooms/${betaRoom.data.id}`, {
    siteId: betaSite.data.id, templateId: betaTemplate.data.id, name: "Changed",
  }), [403]);
  expectStatus("cannot update beta legacy appliance", await staff("PUT", `/pat-track/appliances/${betaAppliance.data.id}`, {
    siteId: betaSite.data.id, name: "Changed appliance",
  }), [403]);
  expectStatus("cannot delete beta legacy appliance", await staff("DELETE", `/pat-track/appliances/${betaAppliance.data.id}`), [403]);
  expectStatus("cannot update beta legacy test", await staff("PUT", `/pat-track/tests/${betaTest.data.id}`, {
    applianceId: betaAppliance.data.id, testDate: fixtureDate, result: "pass",
  }), [403]);
  expectStatus("cannot delete beta legacy test", await staff("DELETE", `/pat-track/tests/${betaTest.data.id}`), [403]);
  expectStatus("cannot update beta certificate", await staff("PUT", `/pat-track/certificates/${betaCertificate.data.id}`,
    certificateBody(betaSite.data.id, betaRoom.data.id, "CHANGED")), [403]);
  expectStatus("cannot update beta replacement", await staff("PUT", `/pat-track/replacements/${betaReplacement.data.id}`, {
    roomId: betaRoom.data.id, applianceName: "Changed", replacedOn: "2025-01-12",
  }), [403]);
  expectStatus("cannot update beta failure", await staff("PUT", `/pat-track/failures/${betaFailure.data.id}`, {
    certificateId: betaCertificate.data.id, roomId: betaRoom.data.id, applianceName: "Changed",
  }), [403]);
  expectStatus("cannot relink alpha room to beta template/site", await staff("PUT", `/pat-track/rooms/${alphaRoom.data.id}`, {
    siteId: betaSite.data.id, templateId: betaTemplate.data.id, name: "Moved",
  }), [403]);

  // A viewer is read-only, including all certificate-led register mutations
  // and the original appliance/test register.
  const viewerEmail = `pat-viewer-${stamp}@test.local`;
  expectStatus("create PAT viewer", await admin("POST", "/users", {
    name: "PAT viewer", email: viewerEmail, password: "password-789",
    role: "client_viewer", clientId,
  }), [200, 201]);
  const viewer = session();
  expectStatus("login PAT viewer", await viewer("POST", "/auth/login", {
    email: viewerEmail, password: "password-789",
  }), [200]);
  for (const [method, path] of [
    ["POST", "/pat-track/equipment-templates"], ["POST", "/pat-track/rooms"],
    ["POST", "/pat-track/certificates"], ["POST", "/pat-track/replacements"],
    ["POST", "/pat-track/failures"], ["POST", "/pat-track/appliances"],
    ["POST", "/pat-track/tests"],
    ["PUT", `/pat-track/equipment-templates/${alphaTemplate.data.id}`],
    ["PUT", `/pat-track/rooms/${alphaRoom.data.id}`],
    ["PUT", `/pat-track/certificates/${alphaCertificate.data.id}`],
    ["PUT", `/pat-track/replacements/${betaReplacement.data.id}`],
    ["PUT", `/pat-track/failures/${betaFailure.data.id}`],
    ["PUT", `/pat-track/appliances/${alphaAppliance.data.id}`],
    ["PUT", `/pat-track/tests/${alphaTest.data.id}`],
    ["DELETE", `/pat-track/equipment-templates/${alphaTemplate.data.id}`],
    ["DELETE", `/pat-track/rooms/${alphaRoom.data.id}`],
    ["DELETE", `/pat-track/certificates/${alphaCertificate.data.id}`],
    ["DELETE", `/pat-track/replacements/${betaReplacement.data.id}`],
    ["DELETE", `/pat-track/failures/${betaFailure.data.id}`],
    ["DELETE", `/pat-track/appliances/${alphaAppliance.data.id}`],
    ["DELETE", `/pat-track/tests/${alphaTest.data.id}`],
  ]) expectStatus(`viewer ${method} ${path} is denied`, await viewer(method, path, {}), [403]);

  // Compliance evidence prevents destructive room moves/deletes, and
  // certificates are immutable evidence rather than deletable records.
  expectStatus("history blocks room site move", await admin("PUT", `/pat-track/rooms/${alphaRoom.data.id}`, {
    siteId: betaSite.data.id, templateId: betaTemplate.data.id, name: "Alpha room",
  }), [409]);
  expectStatus("history blocks room delete", await admin("DELETE", `/pat-track/rooms/${alphaRoom.data.id}`), [409]);
  expectStatus("certificate delete is retained evidence", await admin("DELETE", `/pat-track/certificates/${alphaCertificate.data.id}`), [405]);

  // Use explicit due dates so the boundary is independent of the server clock:
  // only dates before CURRENT_DATE are overdue; inactive rooms are excluded.
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date(); const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const todayRoom = await admin("POST", "/pat-track/rooms", { siteId: alphaSite.data.id, name: "Due today room" });
  const overdueRoom = await admin("POST", "/pat-track/rooms", { siteId: alphaSite.data.id, name: "Overdue room" });
  const untestedRoom = await admin("POST", "/pat-track/rooms", { siteId: alphaSite.data.id, name: "Untested room" });
  const inactiveRoom = await admin("POST", "/pat-track/rooms", { siteId: alphaSite.data.id, name: "Retired room", active: false });
  for (const [name, response] of [["due today room", todayRoom], ["overdue room", overdueRoom], ["untested room", untestedRoom], ["inactive room", inactiveRoom]]) expectStatus(`create ${name}`, response, [201]);
  expectStatus("record certificate due today", await admin("POST", "/pat-track/certificates", {
    ...certificateBody(alphaSite.data.id, todayRoom.data.id, "DUE-TODAY"), visitDate: iso(now), nextTestDue: iso(now),
  }), [201]);
  expectStatus("record overdue certificate", await admin("POST", "/pat-track/certificates", {
    ...certificateBody(alphaSite.data.id, overdueRoom.data.id, "OVERDUE"), visitDate: iso(yesterday), nextTestDue: iso(yesterday),
  }), [201]);
  const overdue = await admin("GET", `/pat-track/overdue-by-room-area?siteId=${alphaSite.data.id}`);
  expectStatus("get room overdue register", overdue, [200]);
  const overdueIds = new Set((overdue.data ?? []).map(row => row.id));
  const overdueById = new Map((overdue.data ?? []).map(row => [row.id, row]));
  check("due today is not overdue", !overdueIds.has(todayRoom.data.id));
  check("past due room is overdue", overdueIds.has(overdueRoom.data.id));
  check("untested active room is listed", overdueIds.has(untestedRoom.data.id));
  check("past due room has overdue status", overdueById.get(overdueRoom.data.id)?.status === "overdue");
  check("untested room has untested status", overdueById.get(untestedRoom.data.id)?.status === "untested");
  check("inactive room is excluded", !overdueIds.has(inactiveRoom.data.id));

  // The cancellation/client export must preserve every certificate-led PAT
  // entity without depending on object storage availability.
  const exportResponse = await fetch(`${BASE}/export`, { headers: { cookie: admin.cookie() } });
  expectStatus("download full client export", exportResponse, [200]);
  const exportPath = join(tmpdir(), `pat-export-${stamp}.zip`);
  try {
    await writeFile(exportPath, Buffer.from(await exportResponse.arrayBuffer()));
    const entries = execFileSync("unzip", ["-Z1", exportPath], { encoding: "utf8" }).split("\n");
    for (const filename of [
      "pat-track/equipment-templates.csv", "pat-track/equipment-template-items.csv",
      "pat-track/rooms.csv", "pat-track/certificates.csv",
      "pat-track/certificate-rooms.csv", "pat-track/replacements.csv",
      "pat-track/failures.csv",
    ]) check(`export includes ${filename}`, entries.includes(filename));
  } finally {
    await rm(exportPath, { force: true });
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});