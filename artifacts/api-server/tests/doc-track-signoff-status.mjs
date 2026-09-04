// End-to-end coverage for DocTrack's current acknowledgement status and the
// Pest Control PAT preset's tenant-scoped template API.
const BASE = process.env.API_BASE || "http://localhost:8080/api";
let cookie = "";
let failures = 0;

function check(name, condition) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
  }
}

function requireSuccess(name, response, expectedStatus) {
  check(name, response.status === expectedStatus);
  if (response.status !== expectedStatus) {
    console.error(`${name}: status ${response.status}`, response.data);
    throw new Error(`${name} setup failed`);
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
  return {
    status: response.status,
    data: (response.headers.get("content-type") ?? "").includes("application/json")
      ? await response.json()
      : null,
  };
}

function isoDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const email = `doc-status-${Date.now()}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: "Doc Status Test", email, password: "password-123",
  });
  requireSuccess("register account", registered, 200);
  check("test server exposes verification token", typeof registered.data?.verificationToken === "string");
  if (typeof registered.data?.verificationToken !== "string") throw new Error("Verification token unavailable; run via the test runner");
  requireSuccess(
    "verify account",
    await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`),
    200,
  );
  requireSuccess("log in", await request("POST", "/auth/login", { email, password: "password-123" }), 200);

  const staff = await request("POST", "/staff-roster", { name: "Alex Staff" });
  requireSuccess("create roster staff", staff, 201);
  const document = await request("POST", "/doc-track/documents", {
    title: "Annual safety policy",
    category: "policy",
    fileName: "annual-safety-policy.pdf",
    mimeType: "application/pdf",
    objectPath: `test/doc-status-${Date.now()}.pdf`,
    requiresAcknowledgement: true,
    annualAcknowledgement: true,
  });
  requireSuccess("create acknowledgement document", document, 201);

  let listed = await request("GET", "/doc-track/documents");
  requireSuccess("list acknowledgement documents", listed, 200);
  check("document list response is an array", Array.isArray(listed.data));
  if (!Array.isArray(listed.data)) throw new Error("Document list response is not an array");
  let row = listed.data.find((item) => item.id === document.data?.id);
  check("new document status is pending", row?.acknowledgement_status === "pending");
  check("new document pending count is returned", Number(row?.pending_acknowledgement_count) === 1);

  const acknowledged = await request("POST", `/doc-track/documents/${document.data?.id}/acknowledge`, {
    acknowledgements: [{ staffRosterId: staff.data?.id, staffName: "Forged name" }],
  });
  check("record acknowledgement", acknowledged.status === 201 && acknowledged.data?.created === 1);
  const trainRecordId = acknowledged.data?.records?.[0]?.train_track_record_id;
  check("acknowledgement links TrainTrack record", typeof trainRecordId === "number");

  listed = await request("GET", "/doc-track/documents");
  row = listed.data?.find((item) => item.id === document.data?.id);
  check("current acknowledgement status is acknowledged", row?.acknowledgement_status === "acknowledged");
  check("current acknowledgement count is returned", Number(row?.acknowledged_count) === 1);

  const expire = await request("PATCH", `/train-track/records/${trainRecordId}`, { expiryDate: isoDate(-1) });
  check("expire linked TrainTrack sign-off", expire.status === 200);
  listed = await request("GET", "/doc-track/documents");
  row = listed.data?.find((item) => item.id === document.data?.id);
  check("DocTrack reconciles expired linked sign-off", row?.acknowledgement_status === "expired");
  check("expired acknowledgement count is returned", Number(row?.expired_acknowledgement_count) === 1);

  const preset = await request("PUT", "/pat-track/preset-templates/pest-control", {
    items: [{ name: "Electric ULV Fogger", type: "Portable Tool" }],
  });
  check("save pest-control PAT template", preset.status === 200 && preset.data?.ok === true);
  const presets = await request("GET", "/pat-track/preset-templates");
  check("read tenant pest-control PAT template", presets.status === 200 && Array.isArray(presets.data?.["pest-control"]));

  if (failures) process.exit(1);
  console.log("DocTrack status reconciliation and pest-control preset checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});