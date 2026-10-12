// Register CSV imports and the consultant portfolio. Run through test:csv-imports-portfolio.
//  - Imports (PAT appliances, RoomTrack rooms, contractors): preview then
//    commit, per-row errors block the whole file, natural-key duplicate
//    detection, site matching by name, blank cells keep existing values.
//  - Roles: viewers and ordinary staff are refused; a PATTrack department
//    manager may import only into their own department's sites; rooms and
//    contractors are admin-only.
//  - Tenant isolation: another consultant cannot import into, list or see
//    branding of a business they are not linked to.
//  - Portfolio: one row per linked business with aggregate counts.
//  - Branding: "Managed by" reaches linked client users only; logo claims are
//    tied to the consultant's own storage tenant.
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required");
const ownership = createFixtureOwnership({ runId: resolveRunId(), suite: "csv-imports-portfolio" });
const run = ownership.runId;
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
  const request = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const type = response.headers.get("content-type") ?? "";
    const data = type.includes("application/json") ? await response.json().catch(() => null) : await response.text();
    return { status: response.status, data, type };
  };
  return request;
}

async function consultant(label) {
  const request = session();
  const email = `csv-import-${label}-${run}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `${label} Consultant`, email, password: "password-123" });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  ownership.trackRegisteredUser();
  if (registered.data?.verificationToken) {
    await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  }
  const loggedIn = await request("POST", "/auth/login", { email, password: "password-123" });
  check(`${label}: login`, loggedIn.status === 200, String(loggedIn.status));
  const me = await request("GET", "/auth/me");
  const clientId = (me.data?.user ?? me.data)?.clientId;
  ownership.trackClient(clientId);
  return { request, clientId };
}

async function member(owner, clientId, label, role, extra = {}) {
  const email = `csv-import-${label}-${run}@test.local`;
  const created = await owner("POST", "/users", { name: label, email, password: "password-123", role, clientId, ...extra });
  check(`${label}: create user`, [200, 201].includes(created.status), `${created.status} ${JSON.stringify(created.data)}`);
  if (extra.isDepartmentManager) {
    const updated = await owner("PUT", `/users/${created.data?.id}`, { isDepartmentManager: true });
    check(`${label}: designate department manager`, updated.status === 200, String(updated.status));
  }
  const request = session();
  const loggedIn = await request("POST", "/auth/login", { email, password: "password-123" });
  check(`${label}: login`, loggedIn.status === 200, String(loggedIn.status));
  return request;
}

const PAT_HEADERS = ["Appliance name", "Asset tag", "Appliance type", "Site", "Location", "Notes"];
const pat = (rows, preview = true) => ({ headers: PAT_HEADERS, rows, preview });
const actions = (data) => Object.fromEntries((data?.rows ?? []).map((row) => [row.row, row.action]));

async function patImports(owner, manager, staff, viewer) {
  const template = await owner("GET", "/imports/pat-appliances/template");
  check("pat: template is a CSV with the expected headers",
    template.status === 200 && template.type.includes("text/csv") && String(template.data).includes('"Appliance name","Asset tag"'),
    `${template.status} ${template.type}`);

  const before = (await owner("GET", "/pat-track/appliances")).data ?? [];
  const mixed = await owner("POST", "/imports/pat-appliances", pat([
    ["Kettle", "PAT-1", "kitchen appliance", "main building", "Staff kitchen", ""],
    ["Toaster", "", "Kitchen Appliance", "Main Building", "Staff kitchen", ""],
    ["Kettle copy", "pat-1", "", "", "", ""],
    ["Lamp", "PAT-3", "Lava lamp", "", "", ""],
    ["Fan", "PAT-4", "", "Nowhere", "", ""],
  ]));
  check("pat: preview reports creates and per-row errors",
    mixed.status === 200 && mixed.data?.summary?.create === 2 && mixed.data?.summary?.error === 3,
    JSON.stringify(mixed.data?.summary));
  check("pat: duplicate asset tag in the file is an error (case-insensitive)",
    mixed.data?.rows?.find((row) => row.row === 4)?.reasons?.some((reason) => reason.includes("Duplicate of row 2")), JSON.stringify(mixed.data?.rows));
  check("pat: unknown site is an error", mixed.data?.rows?.find((row) => row.row === 6)?.reasons?.some((reason) => reason.includes("not found")));
  const blocked = await owner("POST", "/imports/pat-appliances", pat([
    ["Kettle", "PAT-1", "", "", "", ""], ["Fan", "PAT-4", "", "Nowhere", "", ""],
  ], false));
  check("pat: commit with an error row is refused", blocked.status === 409 && blocked.data?.committed === false, String(blocked.status));
  const afterBlocked = (await owner("GET", "/pat-track/appliances")).data ?? [];
  check("pat: refused commit writes nothing", afterBlocked.length === before.length, `${before.length} -> ${afterBlocked.length}`);

  const valid = [
    ["Kettle", "PAT-1", "kitchen appliance", "main building", "Staff kitchen", "Checked"],
    ["Toaster", "", "Kitchen Appliance", "Main Building", "Staff kitchen", ""],
    ["Monitor", "PAT-6", "IT Equipment", "Annexe", "Office", ""],
  ];
  const committed = await owner("POST", "/imports/pat-appliances", pat(valid, false));
  check("pat: valid file commits", committed.status === 200 && committed.data?.committed === true && committed.data?.summary?.create === 3,
    `${committed.status} ${JSON.stringify(committed.data?.summary)}`);
  const appliances = (await owner("GET", "/pat-track/appliances")).data ?? [];
  const kettle = appliances.find((item) => item.asset_tag === "PAT-1");
  check("pat: appliance type and site resolved", kettle?.appliance_type === "Kitchen Appliance" && Number.isInteger(kettle?.site_id), JSON.stringify(kettle));

  const again = await owner("POST", "/imports/pat-appliances", pat(valid));
  check("pat: re-importing the same file skips every row", again.data?.summary?.skip === 3 && again.data?.summary?.create === 0, JSON.stringify(again.data?.summary));
  const changed = await owner("POST", "/imports/pat-appliances", pat([["Kettle", "pat-1", "", "", "Bar", ""]], false));
  check("pat: matching asset tag updates in place", changed.status === 200 && changed.data?.summary?.update === 1, JSON.stringify(changed.data));
  const kettleAfter = ((await owner("GET", "/pat-track/appliances")).data ?? []).find((item) => item.id === kettle?.id);
  check("pat: blank cells keep existing values",
    kettleAfter?.location === "Bar" && kettleAfter?.description === "Checked" && kettleAfter?.site_id === kettle?.site_id
      && kettleAfter?.appliance_type === "Kitchen Appliance", JSON.stringify(kettleAfter));

  const missing = await owner("POST", "/imports/pat-appliances", { headers: ["Asset tag"], rows: [["X"]] });
  check("pat: missing required column is a file error", missing.status === 400 && /Appliance name/.test(missing.data?.error ?? ""), JSON.stringify(missing.data));
  const tooMany = await owner("POST", "/imports/pat-appliances", pat(Array.from({ length: 1001 }, (_, i) => [`Item ${i}`, "", "", "", "", ""])));
  check("pat: more than 1,000 rows is refused", tooMany.status === 400, String(tooMany.status));

  // Department manager: own department only.
  check("pat: department manager can download the template", (await manager("GET", "/imports/pat-appliances/template")).status === 200);
  const otherDept = await manager("POST", "/imports/pat-appliances", pat([
    ["Heater", "PAT-7", "", "Annexe", "", ""],
    ["Monitor", "PAT-6", "", "", "", ""],
    ["Fridge", "PAT-8", "", "Main Building", "Bar", ""],
  ]));
  check("pat: manager cannot import into another department's site",
    actions(otherDept.data)[2] === "error" && otherDept.data?.rows?.[0]?.reasons?.some((reason) => reason.includes("outside your department")),
    JSON.stringify(otherDept.data?.rows));
  check("pat: manager cannot update another department's appliance", actions(otherDept.data)[3] === "error", JSON.stringify(otherDept.data?.rows));
  const own = await manager("POST", "/imports/pat-appliances", pat([["Fridge", "PAT-8", "", "Main Building", "Bar", ""]], false));
  check("pat: manager can import into their own department", own.status === 200 && own.data?.summary?.create === 1, `${own.status} ${JSON.stringify(own.data)}`);

  check("pat: ordinary staff are refused", (await staff("POST", "/imports/pat-appliances", pat([["Iron", "", "", "", "", ""]]))).status === 403);
  check("pat: viewer cannot import", (await viewer("POST", "/imports/pat-appliances", pat([["Iron", "", "", "", "", ""]], false))).status === 403);
  check("pat: viewer cannot download the template", (await viewer("GET", "/imports/pat-appliances/template")).status === 403);
}

async function roomImports(owner, manager, viewer, otherClientId) {
  const headers = ["Room number", "Room name", "Floor", "Site"];
  const duplicate = await owner("POST", "/imports/room-track-rooms", { headers, rows: [["101", "Garden", "Ground", "Main Building"], [" 101 ", "Copy", "", "main building"]] });
  check("rooms: same site and room number twice is an error", duplicate.data?.summary?.error === 1 && duplicate.data?.summary?.create === 1, JSON.stringify(duplicate.data?.summary));
  const committed = await owner("POST", "/imports/room-track-rooms", { headers, rows: [["101", "Garden", "Ground", "Main Building"], ["102", "", "First", ""]], preview: false });
  check("rooms: commit creates rooms", committed.status === 200 && committed.data?.summary?.create === 2, `${committed.status} ${JSON.stringify(committed.data)}`);
  const rooms = (await owner("GET", "/room-track/rooms")).data ?? [];
  check("rooms: imported rooms are listed", rooms.some((room) => room.roomNumber === "101" && room.name === "Garden") && rooms.some((room) => room.roomNumber === "102"));
  const update = await owner("POST", "/imports/room-track-rooms", { headers, rows: [["101", "", "Lower ground", "Main Building"]] });
  check("rooms: matching room previews an update", update.data?.summary?.update === 1, JSON.stringify(update.data?.rows));

  check("rooms: department manager is refused (admin-only register)", (await manager("POST", "/imports/room-track-rooms", { headers, rows: [["9", "", "", ""]] })).status === 403);
  check("rooms: viewer is refused", (await viewer("POST", "/imports/room-track-rooms", { headers, rows: [["9", "", "", ""]], preview: false })).status === 403);

  // A consultant can import into another linked business by choosing it explicitly.
  const second = await owner("POST", `/imports/room-track-rooms?clientId=${otherClientId}`, { headers, rows: [["201", "Second business", "", ""]], preview: false });
  check("rooms: consultant import lands in the selected business", second.status === 200 && second.data?.summary?.create === 1, `${second.status} ${JSON.stringify(second.data)}`);
  const secondRooms = (await owner("GET", `/room-track/rooms?clientId=${otherClientId}`)).data ?? [];
  const firstRooms = (await owner("GET", "/room-track/rooms")).data ?? [];
  check("rooms: imported room is only in the selected business",
    secondRooms.some((room) => room.roomNumber === "201") && !firstRooms.some((room) => room.roomNumber === "201"));
}

async function contractorImports(owner, manager, viewer) {
  const headers = ["Contact name", "Company", "Email", "Trades", "Public liability expiry"];
  const preview = await owner("POST", "/imports/contractors", { headers, rows: [
    ["Sam Patel", "Patel Electrical", "Sam@Example.co.uk", "Electrical; gas kitchen", "31/03/2027"],
    ["No Email", "", "not-an-email", "", ""],
    ["Bad Trade", "", "bad@example.co.uk", "Juggling", ""],
    ["Bad Date", "", "date@example.co.uk", "", "31/02/2027"],
  ] });
  check("contractors: preview flags invalid email, trade and date",
    preview.data?.summary?.create === 1 && preview.data?.summary?.error === 3, JSON.stringify(preview.data?.rows));
  const committed = await owner("POST", "/imports/contractors", { headers, rows: [["Sam Patel", "Patel Electrical", "Sam@Example.co.uk", "Electrical; gas kitchen", "31/03/2027"]], preview: false });
  check("contractors: commit creates the contractor", committed.status === 200 && committed.data?.summary?.create === 1, `${committed.status} ${JSON.stringify(committed.data)}`);
  const sam = ((await owner("GET", "/contractors")).data ?? []).find((item) => item.email === "sam@example.co.uk");
  check("contractors: email, trades and UK date stored",
    sam && JSON.stringify(sam.trades) === JSON.stringify(["electrical", "gas_kitchen"]) && String(sam.publicLiabilityExpiry).startsWith("2027-03-31"),
    JSON.stringify(sam));
  const again = await owner("POST", "/imports/contractors", { headers: ["Email", "Contact name", "Phone"], rows: [["SAM@example.co.uk", "Sam Patel", "01234 567890"]] });
  check("contractors: email match is case-insensitive and previews an update", again.data?.summary?.update === 1, JSON.stringify(again.data?.rows));
  check("contractors: department manager is refused", (await manager("POST", "/imports/contractors", { headers, rows: [["A", "", "a@example.co.uk", "", ""]] })).status === 403);
  check("contractors: viewer is refused", (await viewer("POST", "/imports/contractors", { headers, rows: [["A", "", "a@example.co.uk", "", ""]], preview: false })).status === 403);
  check("contractors: viewer cannot download the template", (await viewer("GET", "/imports/contractors/template")).status === 403);
}

async function isolation(owner, ownerClientId, other, otherClientId) {
  const foreign = await other("POST", `/imports/contractors?clientId=${ownerClientId}`, {
    headers: ["Contact name", "Email"], rows: [["Intruder", "intruder@example.co.uk"]], preview: false,
  });
  check("isolation: consultant cannot import into an unlinked business", foreign.status === 403, String(foreign.status));
  const foreignBody = await other("POST", "/imports/contractors", {
    clientId: ownerClientId, headers: ["Contact name", "Email"], rows: [["Intruder", "intruder@example.co.uk"]], preview: false,
  });
  check("isolation: body clientId for an unlinked business is refused", foreignBody.status === 403, String(foreignBody.status));
  const own = await other("POST", "/imports/contractors", { headers: ["Contact name", "Email"], rows: [["Other Co", "other@example.co.uk"]], preview: false });
  check("isolation: other consultant imports into their own business", own.status === 200 && own.data?.summary?.create === 1);
  const ownerContractors = (await owner("GET", "/contractors")).data ?? [];
  check("isolation: imported contractor is not visible to another tenant",
    !ownerContractors.some((item) => ["intruder@example.co.uk", "other@example.co.uk"].includes(item.email)));
  const sameKey = await other("POST", "/imports/contractors", { headers: ["Contact name", "Email"], rows: [["Sam", "sam@example.co.uk"]] });
  check("isolation: matching only considers the caller's business", sameKey.data?.summary?.create === 1, JSON.stringify(sameKey.data?.rows));
  check("isolation: other consultant's portfolio excludes unlinked businesses",
    ((await other("GET", "/portfolio")).data?.businesses ?? []).every((business) => business.id === otherClientId));
}

async function portfolio(owner, ownerClientId, secondClientId, admin, viewer) {
  const baseline = (await owner("GET", "/portfolio")).data?.businesses ?? [];
  check("portfolio: lists both linked businesses",
    baseline.length === 2 && baseline.some((b) => b.id === ownerClientId) && baseline.some((b) => b.id === secondClientId), JSON.stringify(baseline));
  const first = baseline.find((b) => b.id === ownerClientId);
  check("portfolio: site count", first?.sites === 2, JSON.stringify(first));
  check("portfolio: trial state reported", first?.subscription === "trial", JSON.stringify(first));

  const past = new Date(Date.now() - 5 * 86400000).toISOString();
  const item = await owner("POST", "/compliance-items", { title: `Overdue survey ${run}`, dueDate: past });
  check("portfolio: create overdue check", item.status === 201, String(item.status));
  const action = await owner("POST", `/track-actions?clientId=${secondClientId}`, {
    module: "fix", title: "Repair door closer", severity: "urgent", dueDate: past.slice(0, 10),
  });
  check("portfolio: create overdue action in the second business", action.status === 201, `${action.status} ${JSON.stringify(action.data)}`);
  const after = (await owner("GET", "/portfolio")).data?.businesses ?? [];
  const firstAfter = after.find((b) => b.id === ownerClientId);
  const secondAfter = after.find((b) => b.id === secondClientId);
  check("portfolio: overdue checks counted per business", firstAfter?.overdueChecks === (first?.overdueChecks ?? 0) + 1, JSON.stringify(firstAfter));
  check("portfolio: open and overdue actions counted per business",
    secondAfter?.openActions >= 1 && secondAfter?.overdueActions >= 1 && firstAfter?.overdueActions === 0, JSON.stringify(secondAfter));
  check("portfolio: last activity recorded", !!firstAfter?.lastActivityAt, JSON.stringify(firstAfter));
  check("portfolio: client admin is refused", (await admin("GET", "/portfolio")).status === 403);
  check("portfolio: viewer is refused", (await viewer("GET", "/portfolio")).status === 403);
}

async function branding(owner, ownerClientId, viewer, admin, other, otherAdmin) {
  check("branding: nothing shown before it is set", (await viewer("GET", "/managed-by")).data === null);
  const saved = await owner("PUT", "/consultant-branding", { practiceName: "  Example Safety Partners  " });
  check("branding: consultant saves a practice name", saved.status === 200 && saved.data?.practiceName === "Example Safety Partners", JSON.stringify(saved.data));
  const shown = await viewer("GET", "/managed-by");
  check("branding: linked client viewer sees Managed by", shown.data?.practiceName === "Example Safety Partners" && shown.data?.hasLogo === false, JSON.stringify(shown.data));
  check("branding: linked client admin sees Managed by", (await admin("GET", "/managed-by")).data?.practiceName === "Example Safety Partners");
  check("branding: another tenant's admin does not", (await otherAdmin("GET", "/managed-by")).data === null);
  check("branding: another tenant's admin cannot select the branded business",
    (await otherAdmin("GET", `/managed-by?clientId=${ownerClientId}`)).status === 403);
  check("branding: no logo returns 404", (await viewer("GET", "/managed-by/logo")).status === 404);

  check("branding: viewer cannot set branding", (await viewer("PUT", "/consultant-branding", { practiceName: "Hijack" })).status === 403);
  check("branding: client admin cannot set branding", (await admin("PUT", "/consultant-branding", { practiceName: "Hijack" })).status === 403);
  check("branding: viewer cannot request a logo upload", (await viewer("POST", "/consultant-branding/logo/request-url", { contentType: "image/png", size: 1000 })).status === 403);
  const upload = await owner("POST", "/consultant-branding/logo/request-url", { contentType: "image/png", size: 1000 });
  check("branding: logo upload URL issued or storage reported unavailable",
    (upload.status === 200 && String(upload.data?.objectPath).includes(`/tenant-consultant-`)) || (upload.status === 503 && upload.data?.code === "OBJECT_STORAGE_UNAVAILABLE"),
    `${upload.status} ${JSON.stringify(upload.data)}`);
  check("branding: oversize logo refused", (await owner("POST", "/consultant-branding/logo/request-url", { contentType: "image/png", size: 3 * 1024 * 1024 })).status === 400);
  check("branding: SVG logo refused", (await owner("POST", "/consultant-branding/logo/request-url", { contentType: "image/svg+xml", size: 1000 })).status === 400);
  const claim = await owner("POST", "/consultant-branding/logo", { objectPath: `/objects/uploads/tenant-${ownerClientId}/00000000-0000-0000-0000-000000000000.png` });
  check("branding: a client tenant upload cannot be claimed as a logo", claim.status === 403, `${claim.status} ${JSON.stringify(claim.data)}`);
  const otherClaim = await other("POST", "/consultant-branding/logo", { objectPath: "/objects/uploads/tenant-consultant-1/00000000-0000-0000-0000-000000000000.png" });
  check("branding: another consultant's upload cannot be claimed", [403, 404].includes(otherClaim.status), String(otherClaim.status));
  const cleared = await owner("PUT", "/consultant-branding", { practiceName: "" });
  check("branding: clearing the name hides Managed by", cleared.status === 200 && (await viewer("GET", "/managed-by")).data === null);
}

async function main() {
  try {
    const a = await consultant("owner");
    const b = await consultant("other");
    if (!a.clientId || !b.clientId) { process.exitCode = 1; return; }
    const owner = a.request;
    const second = await owner("POST", "/clients", { name: `Second business ${run}`, slug: `csv-import-second-${run}` });
    check("setup: second business", second.status === 201 || second.status === 200, String(second.status));
    const secondClientId = second.data?.id;
    ownership.trackClient(secondClientId);

    const deptA = await owner("POST", "/departments", { name: "Front of house" });
    const deptB = await owner("POST", "/departments", { name: "Grounds" });
    const main = await owner("POST", "/sites", { name: "Main Building", departmentId: deptA.data?.id });
    const annexe = await owner("POST", "/sites", { name: "Annexe", departmentId: deptB.data?.id });
    check("setup: sites", main.status === 201 && annexe.status === 201, `${main.status} ${annexe.status}`);

    const manager = await member(owner, a.clientId, "manager", "client_staff", { departmentId: deptA.data?.id, isDepartmentManager: true });
    const staff = await member(owner, a.clientId, "staff", "client_staff", { departmentId: deptA.data?.id });
    const viewer = await member(owner, a.clientId, "viewer", "client_viewer");
    const admin = await member(owner, a.clientId, "admin", "client_admin");
    const otherAdmin = await member(b.request, b.clientId, "otheradmin", "client_admin");

    await patImports(owner, manager, staff, viewer);
    await roomImports(owner, manager, viewer, secondClientId);
    await contractorImports(owner, manager, viewer);
    await isolation(owner, a.clientId, b.request, b.clientId);
    await portfolio(owner, a.clientId, secondClientId, admin, viewer);
    await branding(owner, a.clientId, viewer, admin, b.request, otherAdmin);
  } finally {
    await ownership.cleanup();
  }
  console.log(`${passed} csv-imports-portfolio checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
