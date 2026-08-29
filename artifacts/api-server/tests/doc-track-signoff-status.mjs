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
  check("register account", [200, 201].includes(registered.status));
  if (registered.data?.verificationToken) {
    check("verify account", (await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);
    check("log in", (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  }

  const staff = await request("POST", "/staff-roster", { name: "Alex Staff" });
  check("create roster staff", staff.status === 201);
  const document = await request("POST", "/doc-track/documents", {
    title: "Annual safety policy",
    category: "policy",
    fileName: "annual-safety-policy.pdf",
    mimeType: "application/pdf",
    objectPath: `test/doc-status-${Date.now()}.pdf`,
    requiresAcknowledgement: true,
    annualAcknowledgement: true,
  });
  check("create acknowledgement document", document.status === 201);

  let listed = await request("GET", "/doc-track/documents");
  let row = listed.data?.find((item) => item.id === document.data?.id);
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