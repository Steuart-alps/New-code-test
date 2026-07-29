// Integration tests: DailyTrack submission-lock enforcement.
//
// Verifies that once a checklist or manager sign-off is submitted:
//   - PUT returns 409 (edit blocked)
//   - DELETE returns 409 (delete blocked)
//
// Also verifies the positive path:
//   - Draft records ARE editable and deletable
//   - Sign-offs in draft state ARE editable and deletable
//
// Usage: node tests/dailytrack-locks.mjs
// Exits 0 when all checks pass, 1 otherwise.

const BASE = process.env.API_BASE || "http://localhost:8080/api";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`);
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

function isoDate(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// AM checklists (kitchen_opening / premises_opening)
// ─────────────────────────────────────────────────────────────────────────────

async function testAmLocks(req) {
  console.log("\n── DailyTrack AM — submission locks ──");

  // 1. Create a DRAFT kitchen_opening checklist
  const draftDate = isoDate(-10);
  const createRes = await req("POST", "/daily-track-am", {
    checklistType: "kitchen_opening",
    checkDate: draftDate,
    items: [{ label: "Hands washed", checked: false }],
    completedBy: "Test Staff",
  });
  check("am: POST creates draft", createRes.status === 201, `status=${createRes.status}`);
  const draftId = createRes.data?.id;
  check("am: draft has no submittedAt", createRes.data?.submittedAt == null, `submittedAt=${createRes.data?.submittedAt}`);

  // 2. Draft is editable (PUT succeeds)
  const editDraftRes = await req("PUT", `/daily-track-am/${draftId}`, {
    completedBy: "Updated Staff",
  });
  check("am: PUT on draft → 200", editDraftRes.status === 200, `status=${editDraftRes.status}`);
  check("am: PUT on draft persists change", editDraftRes.data?.completedBy === "Updated Staff", `got ${editDraftRes.data?.completedBy}`);

  // 3. Submit the checklist
  const submittedAt = new Date().toISOString();
  const submitRes = await req("PUT", `/daily-track-am/${draftId}`, {
    submittedAt,
    completedBy: "Final Staff",
  });
  check("am: PUT to submit → 200", submitRes.status === 200, `status=${submitRes.status}`);
  check("am: submitted record has submittedAt set", submitRes.data?.submittedAt != null, `submittedAt=${submitRes.data?.submittedAt}`);

  // 4. PUT on submitted record → 409
  const editSubmittedRes = await req("PUT", `/daily-track-am/${draftId}`, {
    completedBy: "Hacker",
  });
  check("am: PUT on submitted checklist → 409", editSubmittedRes.status === 409, `status=${editSubmittedRes.status}`);

  // 5. DELETE on submitted record → 409
  const delSubmittedRes = await req("DELETE", `/daily-track-am/${draftId}`);
  check("am: DELETE on submitted checklist → 409", delSubmittedRes.status === 409, `status=${delSubmittedRes.status}`);

  // 6. Submitted record still exists and is unchanged
  const getRes = await req("GET", `/daily-track-am/${draftId}`);
  check("am: submitted record still retrievable", getRes.status === 200, `status=${getRes.status}`);
  check("am: submitted record not mutated", getRes.data?.completedBy === "Final Staff", `got ${getRes.data?.completedBy}`);

  // 7. Create another draft and confirm it CAN be deleted
  const deletableDate = isoDate(-11);
  const deletableRes = await req("POST", "/daily-track-am", {
    checklistType: "premises_opening",
    checkDate: deletableDate,
    items: [],
  });
  check("am: POST draft for delete test", deletableRes.status === 201, `status=${deletableRes.status}`);
  const deletableId = deletableRes.data?.id;

  const delDraftRes = await req("DELETE", `/daily-track-am/${deletableId}`);
  check("am: DELETE on draft checklist → 204", delDraftRes.status === 204, `status=${delDraftRes.status}`);

  // 8. Deleted draft is gone
  const getDeletedRes = await req("GET", `/daily-track-am/${deletableId}`);
  check("am: deleted draft returns 404", getDeletedRes.status === 404, `status=${getDeletedRes.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PM checklists (kitchen_closing / premises_closing)
// ─────────────────────────────────────────────────────────────────────────────

async function testPmChecklistLocks(req) {
  console.log("\n── DailyTrack PM — checklist submission locks ──");

  // 1. Create a DRAFT kitchen_closing checklist
  const draftDate = isoDate(-20);
  const createRes = await req("POST", "/daily-track-pm", {
    checklistType: "kitchen_closing",
    checkDate: draftDate,
    items: [{ label: "Ovens off", checked: false }],
    completedBy: "PM Test Staff",
  });
  check("pm-checklist: POST creates draft", createRes.status === 201, `status=${createRes.status}`);
  const draftId = createRes.data?.id;
  check("pm-checklist: draft has no submittedAt", createRes.data?.submittedAt == null, `submittedAt=${createRes.data?.submittedAt}`);

  // 2. Draft is editable
  const editDraftRes = await req("PUT", `/daily-track-pm/${draftId}`, {
    completedBy: "Updated PM Staff",
  });
  check("pm-checklist: PUT on draft → 200", editDraftRes.status === 200, `status=${editDraftRes.status}`);
  check("pm-checklist: PUT on draft persists change", editDraftRes.data?.completedBy === "Updated PM Staff", `got ${editDraftRes.data?.completedBy}`);

  // 3. Submit
  const submittedAt = new Date().toISOString();
  const submitRes = await req("PUT", `/daily-track-pm/${draftId}`, { submittedAt, completedBy: "Final PM Staff" });
  check("pm-checklist: PUT to submit → 200", submitRes.status === 200, `status=${submitRes.status}`);
  check("pm-checklist: submitted record has submittedAt", submitRes.data?.submittedAt != null, `submittedAt=${submitRes.data?.submittedAt}`);

  // 4. PUT on submitted → 409
  const editSubmittedRes = await req("PUT", `/daily-track-pm/${draftId}`, { completedBy: "Hacker" });
  check("pm-checklist: PUT on submitted → 409", editSubmittedRes.status === 409, `status=${editSubmittedRes.status}`);

  // 5. DELETE on submitted → 409
  const delSubmittedRes = await req("DELETE", `/daily-track-pm/${draftId}`);
  check("pm-checklist: DELETE on submitted → 409", delSubmittedRes.status === 409, `status=${delSubmittedRes.status}`);

  // 6. Record still exists intact
  const getRes = await req("GET", `/daily-track-pm/${draftId}`);
  check("pm-checklist: submitted record still retrievable", getRes.status === 200, `status=${getRes.status}`);
  check("pm-checklist: record not mutated", getRes.data?.completedBy === "Final PM Staff", `got ${getRes.data?.completedBy}`);

  // 7. Draft CAN be deleted
  const deletableDate = isoDate(-21);
  const deletableRes = await req("POST", "/daily-track-pm", {
    checklistType: "premises_closing",
    checkDate: deletableDate,
    items: [],
  });
  check("pm-checklist: POST draft for delete test", deletableRes.status === 201, `status=${deletableRes.status}`);
  const deletableId = deletableRes.data?.id;

  const delDraftRes = await req("DELETE", `/daily-track-pm/${deletableId}`);
  check("pm-checklist: DELETE on draft → 204", delDraftRes.status === 204, `status=${delDraftRes.status}`);

  const getDeletedRes = await req("GET", `/daily-track-pm/${deletableId}`);
  check("pm-checklist: deleted draft → 404", getDeletedRes.status === 404, `status=${getDeletedRes.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PM manager sign-offs
// ─────────────────────────────────────────────────────────────────────────────

async function testSignoffLocks(req) {
  console.log("\n── DailyTrack PM — manager sign-off submission locks ──");

  // 1. Create a DRAFT sign-off (no submittedAt)
  const signoffDate = isoDate(-30);
  const createRes = await req("POST", "/daily-track-pm/signoffs", {
    signoffDate,
    managerName: "Test Manager",
    notes: "End of day check complete",
  });
  check("signoff: POST creates draft", createRes.status === 201, `status=${createRes.status}`);
  const signoffId = createRes.data?.id;
  check("signoff: draft has no submittedAt", createRes.data?.submittedAt == null, `submittedAt=${createRes.data?.submittedAt}`);

  // 2. Draft sign-off is editable
  const editDraftRes = await req("PUT", `/daily-track-pm/signoffs/${signoffId}`, {
    notes: "Updated notes before submission",
  });
  check("signoff: PUT on draft → 200", editDraftRes.status === 200, `status=${editDraftRes.status}`);
  check("signoff: PUT on draft persists notes", editDraftRes.data?.notes === "Updated notes before submission", `got ${editDraftRes.data?.notes}`);

  // 3. Submit the sign-off
  const submittedAt = new Date().toISOString();
  const submitRes = await req("PUT", `/daily-track-pm/signoffs/${signoffId}`, {
    submittedAt,
    notes: "Signed off for the day",
  });
  check("signoff: PUT to submit → 200", submitRes.status === 200, `status=${submitRes.status}`);
  check("signoff: submitted sign-off has submittedAt", submitRes.data?.submittedAt != null, `submittedAt=${submitRes.data?.submittedAt}`);

  // 4. PUT on submitted sign-off → 409
  const editSubmittedRes = await req("PUT", `/daily-track-pm/signoffs/${signoffId}`, {
    notes: "Malicious edit",
  });
  check("signoff: PUT on submitted sign-off → 409", editSubmittedRes.status === 409, `status=${editSubmittedRes.status}`);

  // 5. DELETE on submitted sign-off → 409
  const delSubmittedRes = await req("DELETE", `/daily-track-pm/signoffs/${signoffId}`);
  check("signoff: DELETE on submitted sign-off → 409", delSubmittedRes.status === 409, `status=${delSubmittedRes.status}`);

  // 6. Sign-off still exists and is intact
  const listRes = await req("GET", `/daily-track-pm/signoffs?date=${signoffDate}`);
  check("signoff: submitted sign-off still in list", listRes.status === 200, `status=${listRes.status}`);
  const found = (listRes.data ?? []).find((r) => r.id === signoffId);
  check("signoff: sign-off found in list", !!found, "not found in list");
  check("signoff: notes not mutated", found?.notes === "Signed off for the day", `got ${found?.notes}`);

  // 7. Draft sign-off CAN be deleted
  const deletableDate = isoDate(-31);
  const deletableRes = await req("POST", "/daily-track-pm/signoffs", {
    signoffDate: deletableDate,
    managerName: "Draft Manager",
  });
  check("signoff: POST draft for delete test", deletableRes.status === 201, `status=${deletableRes.status}`);
  const deletableId = deletableRes.data?.id;

  const delDraftRes = await req("DELETE", `/daily-track-pm/signoffs/${deletableId}`);
  check("signoff: DELETE on draft sign-off → 204", delDraftRes.status === 204, `status=${delDraftRes.status}`);

  // 8. Confirm deleted draft is gone
  const listAfterDel = await req("GET", `/daily-track-pm/signoffs?date=${deletableDate}`);
  check(
    "signoff: deleted draft not in list",
    !(listAfterDel.data ?? []).some((r) => r.id === deletableId),
    "deleted draft still in list",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const req = makeSession();

  // Register a fresh account for isolation
  const email = `dailytrack-locks-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const regRes = await req("POST", "/auth/register", {
    name: "DailyTrack Lock Test Account",
    email,
    password: "password-123",
  });
  if (![200, 201].includes(regRes.status)) {
    console.error("FATAL: registration failed", regRes.status, regRes.data);
    process.exit(1);
  }

  await testAmLocks(req);
  await testPmChecklistLocks(req);
  await testSignoffLocks(req);

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
