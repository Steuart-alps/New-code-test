// Focused FixTrack detail/history regression coverage.
// Usage: node tests/fix-track-history.mjs (with the API server running).
const BASE = process.env.API_BASE || "http://localhost:8080/api";
const date = new Date().toISOString().slice(0, 10);
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
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

async function tenant(label) {
  const req = session();
  const email = `fix-history-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await req("POST", "/auth/register", {
    name: `${label} FixTrack User`, email, password: "password-123",
  });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  if (!registered.data?.verificationToken) throw new Error(`${label}: missing verification token`);
  check(`${label}: verify`, (await req("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);
  check(`${label}: login`, (await req("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  return req;
}

async function main() {
  const owner = await tenant("owner");
  const otherTenant = await tenant("other");
  const created = await owner("POST", "/fix-track/issues", {
    title: "History ordering regression", issueType: "general", location: "Plant room",
    reportedBy: "Facilities team", reportedDate: date,
  });
  check("create reported issue", created.status === 201, String(created.status));
  const id = created.data?.id;
  const openWork = await owner("GET", "/fix-track/issues?status=reported&status=in_progress");
  check("mobile open-work list includes reported issue",
    openWork.status === 200 && Array.isArray(openWork.data) && openWork.data.some((issue) => issue.id === id),
    JSON.stringify(openWork.data));

  check("reject skipped reported → resolved transition",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "resolved" })).status === 409);
  check("advance reported → in progress",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "in_progress" })).status === 200);
  check("append attributed note",
    (await owner("POST", `/fix-track/issues/${id}/notes`, { note: "Engineer booked" })).status === 200);
  check("advance in progress → resolved",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "resolved" })).status === 200);
  check("advance resolved → closed",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "closed" })).status === 200);

  const detail = await owner("GET", `/fix-track/issues/${id}`);
  check("manager/mobile detail loads", detail.status === 200, String(detail.status));
  check("resolved issue snapshots authenticated resolver name",
    detail.data?.resolvedByName === "owner FixTrack User",
    JSON.stringify(detail.data));
  check("status history is chronological and complete",
    JSON.stringify(detail.data?.statusEvents?.map((event) => event.status)) ===
      JSON.stringify(["reported", "in_progress", "resolved", "closed"]),
    JSON.stringify(detail.data?.statusEvents));
  check("note is retained with its authenticated author",
    detail.data?.notes?.length === 1 &&
      detail.data.notes[0].note === "Engineer booked" &&
      detail.data.notes[0].createdBy === "owner FixTrack User",
    JSON.stringify(detail.data?.notes));

  for (const [label, method, path, body] of [
    ["foreign detail", "GET", `/fix-track/issues/${id}`],
    ["foreign transition", "PUT", `/fix-track/issues/${id}`, { status: "in_progress" }],
    ["foreign note", "POST", `/fix-track/issues/${id}/notes`, { note: "unauthorised" }],
  ]) {
    const result = await otherTenant(method, path, body);
    check(`tenant isolation: ${label}`, [400, 403, 404].includes(result.status), String(result.status));
  }

  console.log(`${passed} FixTrack history checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });