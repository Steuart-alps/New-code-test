// Focused compliance audit coverage. Run through test:compliance-audit-history:ci.
// It verifies that lifecycle entries retain actor/timestamp/snapshots, remain
// visible after deletion, and cannot be read from another tenant.
const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
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
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function tenant(label) {
  const request = session();
  const email = `compliance-audit-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: `${label} Compliance Manager`, email, password: "password-123",
  });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  if (!registered.data?.verificationToken) return null;
  const verified = await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  check(`${label}: verify`, verified.status === 200, String(verified.status));
  const loggedIn = await request("POST", "/auth/login", { email, password: "password-123" });
  check(`${label}: login`, loggedIn.status === 200, String(loggedIn.status));
  return loggedIn.status === 200 ? request : null;
}

async function main() {
  const owner = await tenant("owner");
  const other = await tenant("other");
  if (!owner || !other) {
    process.exitCode = 1;
    return;
  }

  const created = await owner("POST", "/compliance-items", { title: "Audit test inspection", status: "pending" });
  const id = created.data?.id;
  check("create compliance item", created.status === 201 && Number.isInteger(id), String(created.status));
  const updated = await owner("PUT", `/compliance-items/${id}`, { notes: "Inspection evidence amended" });
  check("update compliance item", updated.status === 200, String(updated.status));
  const status = await owner("PATCH", `/compliance-items/${id}/status`, { status: "completed" });
  check("change compliance status", status.status === 200, String(status.status));

  const beforeDelete = await owner("GET", `/audit-events?entityType=compliance_item&entityId=${id}`);
  const events = beforeDelete.data ?? [];
  check("history records actor, timestamp and snapshots",
    beforeDelete.status === 200 && events.length === 3 &&
    events.every((event) => event.actorId && event.actorName && event.createdAt) &&
    events.some((event) => event.action === "updated" && event.before?.notes !== event.after?.notes) &&
    events.some((event) => event.action === "status_changed" && event.before?.status === "pending" && event.after?.status === "completed"),
    JSON.stringify(events));

  const foreign = await other("GET", `/audit-events?entityType=compliance_item&entityId=${id}`);
  check("tenant isolation hides compliance history", foreign.status === 200 && !(foreign.data ?? []).some((event) => event.id === events[0]?.id), String(foreign.status));

  const deleted = await owner("DELETE", `/compliance-items/${id}`);
  check("delete compliance item", deleted.status === 204, String(deleted.status));
  const afterDelete = await owner("GET", `/audit-events?entityType=compliance_item&entityId=${id}`);
  check("audit trail is append-only across deletion",
    afterDelete.status === 200 && afterDelete.data?.length === 4 &&
    afterDelete.data.some((event) => event.action === "deleted") &&
    events.every((event) => afterDelete.data.some((later) => later.id === event.id)),
    JSON.stringify(afterDelete.data));

  console.log(`${passed} compliance audit-history checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });