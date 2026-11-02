// TreeTrack tree register: trees with their place, what3words address and
// GPS spot; each tree's next inspection from its last routine inspection and
// interval; a failed inspection flags the tree until one passes; an inspection
// for a tree takes the tree's site; Owner-only register changes; trees with
// records can't be deleted; per-tree due dates on the dashboard; tenant
// isolation. Runs only through tests/run-fresh-schema.sh (disposable database).
const BASE = process.env.API_BASE;
if (process.env.FRESH_SCHEMA_TEST !== "1" || !BASE) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/tree-register.mjs (disposable database only)");
}
let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}: ${detail}`); console.error(`FAIL: ${name}: ${detail}`); }
}
const expectStatus = (name, response, expected) => check(name, expected.includes(response.status), `expected ${expected.join("/")}, got ${response.status} ${JSON.stringify(response.data)}`);
function session(defaultHeaders = {}) {
  let cookie = "";
  const request = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...defaultHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (response.headers.get("content-type") || "").includes("application/json") ? await response.json().catch(() => null) : null;
    return { status: response.status, data };
  };
  return request;
}

const password = "password-123";
async function registerTenant(label, stamp) {
  // Historic test dates need an override reason.
  const user = session({ "X-Override-Reason": encodeURIComponent("Tree fixture: historic inspections") });
  const email = `tree-register-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `Trees ${label}`, email, password });
  expectStatus(`register ${label}`, registered, [200, 201]);
  if (typeof registered.data?.verificationToken !== "string") throw new Error("Verification token unavailable; run via the test runner");
  expectStatus(`verify ${label}`, await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
  expectStatus(`login ${label}`, await user("POST", "/auth/login", { email, password }), [200]);
  return user;
}

function iso(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function isoMonthsAgo(months) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const stamp = Date.now();
  const owner = await registerTenant("owner", stamp);
  const other = await registerTenant("other", stamp);

  const site = await owner("POST", "/sites", { name: "Main Course" });
  expectStatus("create site", site, [200, 201]);
  const siteId = site.data?.id;

  // ── Register ───────────────────────────────────────────────────────────────
  const t12 = await owner("POST", "/tree-track/trees", {
    ref: "T12", species: "Beech", siteId, location: "By the 9th tee",
    what3words: "///Filled.Count.Soap", latitude: 55.6112, longitude: -4.4957, riskZone: "high", inspectionIntervalMonths: 12,
  });
  expectStatus("add tree", t12, [201]);
  check("what3words stored as word.word.word", t12.data?.what3words === "filled.count.soap", JSON.stringify(t12.data));
  check("GPS spot stored", t12.data?.latitude === 55.6112 && t12.data?.longitude === -4.4957, JSON.stringify(t12.data));

  expectStatus("two-word what3words refused", await owner("POST", "/tree-track/trees", { ref: "T13", what3words: "two.words" }), [400]);
  expectStatus("tree needs a reference", await owner("POST", "/tree-track/trees", { ref: "  " }), [400]);
  expectStatus("another business's site refused", await other("POST", "/tree-track/trees", { ref: "X1", siteId }), [400]);

  const t3 = await owner("POST", "/tree-track/trees", { ref: "T3", inspectionIntervalMonths: 6 });
  expectStatus("add tree without site", t3, [201]);
  check("register defaults", t3.data?.riskZone === "medium" && t3.data?.what3words === null, JSON.stringify(t3.data));

  let trees = (await owner("GET", "/tree-track/trees")).data ?? [];
  check("new trees are due now", trees.length === 2 && trees.every((t) => t.status === "never" && t.nextDue === null), JSON.stringify(trees));

  // ── Inspections against trees ──────────────────────────────────────────────
  const failed = await owner("POST", "/tree-track", {
    checkType: "visual_assessment", checkDate: iso(0), result: "fail", actionSeverity: "urgent_action",
    treeId: t12.data.id, what3words: "index home raft", latitude: 55.6113, longitude: -4.4958,
  });
  expectStatus("record failed inspection for a tree", failed, [201]);
  check("inspection takes the tree's site, ref and place", failed.data?.siteId === siteId && failed.data?.treeRef === "T12" && failed.data?.location === "By the 9th tee", JSON.stringify(failed.data));
  check("issue keeps its own what3words address", failed.data?.what3words === "index.home.raft", JSON.stringify(failed.data));

  trees = (await owner("GET", "/tree-track/trees")).data ?? [];
  let beech = trees.find((t) => t.ref === "T12");
  check("failed tree is flagged", beech?.openIssue?.severity === "urgent_action", JSON.stringify(beech));
  check("next due a year after the inspection", beech?.status === "ok" && beech?.lastInspected === iso(0) && beech?.nextDue?.slice(5) === iso(0).slice(5), JSON.stringify(beech));

  const passedLater = await owner("POST", "/tree-track", { checkType: "remedial_works", checkDate: iso(0), result: "pass", treeId: t12.data.id });
  expectStatus("record works that pass", passedLater, [201]);
  beech = ((await owner("GET", "/tree-track/trees")).data ?? []).find((t) => t.ref === "T12");
  check("a later pass clears the flag", beech?.openIssue === null, JSON.stringify(beech));
  check("works records don't restart the routine clock", beech?.lastInspected === iso(0), JSON.stringify(beech));

  const old = await owner("POST", "/tree-track", { checkType: "visual_assessment", checkDate: isoMonthsAgo(8), result: "pass", treeId: t3.data.id });
  expectStatus("record an old inspection", old, [201]);
  const t3Status = ((await owner("GET", "/tree-track/trees")).data ?? []).find((t) => t.ref === "T3");
  check("six-monthly tree inspected eight months ago is overdue", t3Status?.status === "overdue", JSON.stringify(t3Status));

  expectStatus("another business's tree refused", await other("POST", "/tree-track", { checkType: "visual_assessment", checkDate: iso(0), result: "pass", treeId: t12.data.id }), [400]);
  check("trees stay in their business", ((await other("GET", "/tree-track/trees")).data ?? []).length === 0);
  expectStatus("another business can't change a tree", await other("PUT", `/tree-track/trees/${t12.data.id}`, { ref: "Hijack" }), [404]);

  // ── Dashboard ──────────────────────────────────────────────────────────────
  const summary = (await owner("GET", "/dashboard/summary")).data;
  const tree = (summary?.tracks ?? []).find((t) => t.trackId === "tree");
  check("overdue tree on the dashboard", tree?.items?.some((i) => i.label === "Tree T3" && /overdue/.test(i.detail)), JSON.stringify(tree));

  // ── Felled, deleted, roles ─────────────────────────────────────────────────
  expectStatus("tree with inspections can't be deleted", await owner("DELETE", `/tree-track/trees/${t3.data.id}`), [409]);
  const felled = await owner("PUT", `/tree-track/trees/${t3.data.id}`, { removedAt: iso(0) });
  expectStatus("mark tree felled", felled, [200]);
  trees = (await owner("GET", "/tree-track/trees")).data ?? [];
  check("felled tree leaves the list", trees.length === 1 && trees[0].ref === "T12", JSON.stringify(trees));
  check("felled tree shown on request", ((await owner("GET", "/tree-track/trees?includeRemoved=true")).data ?? []).length === 2);
  const after = (await owner("GET", "/dashboard/summary")).data;
  check("felled tree off the dashboard", !((after?.tracks ?? []).find((t) => t.trackId === "tree")?.items ?? []).some((i) => i.label === "Tree T3"));

  const mistake = await owner("POST", "/tree-track/trees", { ref: "Typo" });
  expectStatus("delete a tree added by mistake", await owner("DELETE", `/tree-track/trees/${mistake.data.id}`), [204]);

  const staffEmail = `tree-register-staff-${stamp}@test.local`;
  expectStatus("add staff", await owner("POST", "/users", { name: "Tree staff", email: staffEmail, password, role: "client_staff" }), [201]);
  const staff = session();
  expectStatus("staff login", await staff("POST", "/auth/login", { email: staffEmail, password }), [200]);
  expectStatus("staff see the tree list", await staff("GET", "/tree-track/trees"), [200]);
  expectStatus("staff can't add trees", await staff("POST", "/tree-track/trees", { ref: "S1" }), [403]);
  expectStatus("staff record an inspection for a tree", await staff("POST", "/tree-track", { checkType: "visual_assessment", checkDate: iso(0), result: "pass", treeId: t12.data.id }), [201]);

  console.log(`tree register: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
