// Behavioural check that client_viewer accounts reach only their own
// training records.
//
// A Viewer is a member of staff linked to their staff roster entry: they see
// that person's TrainTrack records and can sign them off, and nothing else
// (middleware/viewerScope.ts). tests/viewer-route-policy.mjs proves each
// mutation route declares a viewer guard; it cannot prove what is reached at
// runtime. This suite signs in a department viewer in a fresh tenant and:
//   1. checks they see only their own training records, can sign an unsigned
//      one once, and can't sign anyone else's;
//   2. for one record in every module family, checks the viewer gets 403 on
//      read, create, edit and delete, and leaves the record unchanged;
//   3. sends every guarded POST/PUT/PATCH/DELETE route (found from the route
//      files and their mounts in src/routes/index.ts) as the viewer and
//      expects 403.
//
// Usage: node tests/viewer-read-only.mjs (API must be running on API_BASE).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const expect = (name, result, statuses) =>
  check(name, statuses.includes(result.status), `got ${result.status} ${JSON.stringify(result.data)?.slice(0, 200)}`);
const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
function session() {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = r.headers.get("content-type")?.includes("json") ? await r.json().catch(() => null) : null;
    return { status: r.status, data };
  };
}
const rowsOf = (data) => (Array.isArray(data) ? data : data?.items ?? data?.rows ?? data?.data ?? data?.tasks ?? []);
const idOf = (row) => row?.id ?? row?.task?.id;

// Guarded mutation routes with their mounted paths, read from the source.
const VIEWER_GUARD = /\bdenyViewers\b|\brequire(?:ClientAdmin|Consultant|Role)\b/;
function guardedRoutes() {
  const routesDirectory = fileURLToPath(new URL("../src/routes", import.meta.url));
  const parse = (file) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const index = parse(`${routesDirectory}/index.ts`);
  const importedFrom = new Map();
  for (const statement of index.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const from = statement.moduleSpecifier.text;
    if (!from.startsWith("./")) continue;
    const file = `${from.slice(2)}.ts`;
    const clause = statement.importClause;
    if (clause.name) importedFrom.set(clause.name.text, { file, name: "router" });
    for (const element of clause.namedBindings?.elements ?? []) {
      importedFrom.set(element.name.text, { file, name: (element.propertyName ?? element.name).text });
    }
  }
  const mounts = [];
  const visitIndex = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(index) === "router.use") {
      const [first] = node.arguments;
      const prefix = first && ts.isStringLiteral(first) ? first.text : "";
      for (const arg of node.arguments) {
        if (ts.isIdentifier(arg) && importedFrom.has(arg.text)) mounts.push({ prefix, ...importedFrom.get(arg.text) });
      }
    }
    ts.forEachChild(node, visitIndex);
  };
  visitIndex(index);

  const routes = [];
  const files = execFileSync("find", [routesDirectory, "-maxdepth", "1", "-name", "*.ts", "-print"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  for (const file of files) {
    const name = basename(file);
    const sourceFile = parse(file);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["post", "put", "patch", "delete"].includes(node.expression.name.text)) {
        const receiver = node.expression.expression.getText(sourceFile);
        const [pathArg, ...rest] = node.arguments;
        const middleware = rest.slice(0, -1).map((arg) => arg.getText(sourceFile)).join(" ");
        if (pathArg && ts.isStringLiteralLike(pathArg) && VIEWER_GUARD.test(middleware)) {
          for (const mount of mounts.filter((m) => m.file === name && m.name === receiver)) {
            routes.push({ method: node.expression.name.text.toUpperCase(), path: `${mount.prefix}${pathArg.text}`, where: name });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return routes;
}

async function main() {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const today = iso(0);
  const admin = session();
  const email = `viewer-ro-admin-${suffix}@test.local`;
  const registered = await admin("POST", "/auth/register", { name: "Viewer Read-only Admin", email, password: "password-123" });
  if (![200, 201].includes(registered.status)) throw new Error(`registration failed: ${registered.status}`);
  const token = registered.data?.verificationToken;
  if (token) await admin("GET", `/auth/verify-email?token=${encodeURIComponent(token)}`);
  expect("login admin", await admin("POST", "/auth/login", { email, password: "password-123" }), [200]);
  const me = await admin("GET", "/auth/me");
  const clientId = me.data?.user?.clientId ?? me.data?.clientId;
  check("admin has tenant", Number.isInteger(clientId), JSON.stringify(me.data));

  const department = await admin("POST", "/departments", { name: `Viewer dept ${suffix}` });
  expect("create department", department, [200, 201]);
  const site = await admin("POST", "/sites", {
    name: `Viewer site ${suffix}`, departmentId: department.data?.id, seedStarterChecks: false,
  });
  expect("create site", site, [200, 201]);
  const siteId = site.data?.id;
  const viewerEmail = `viewer-ro-${suffix}@test.local`;
  // The roster entry carries the same email, so the new Viewer is linked to it.
  const ownEntry = await admin("POST", "/staff-roster", { name: "Read-only Viewer", email: viewerEmail, siteId });
  const otherEntry = await admin("POST", "/staff-roster", { name: "Someone Else", siteId });
  expect("create roster entries", ownEntry, [200, 201]);
  expect("create second roster entry", otherEntry, [200, 201]);
  const createdViewer = await admin("POST", "/users", {
    name: "Read-only Viewer", email: viewerEmail, password: "password-123",
    role: "client_viewer", clientId, departmentId: department.data?.id,
  });
  expect("create department viewer", createdViewer, [200, 201]);
  check("viewer is linked to the roster entry with their email", createdViewer.data?.staffRosterId === ownEntry.data?.id,
    JSON.stringify(createdViewer.data));
  const viewer = session();
  expect("login viewer", await viewer("POST", "/auth/login", { email: viewerEmail, password: "password-123" }), [200]);
  if (!Number.isInteger(siteId)) throw new Error("site setup failed");

  // Their own training records, and nobody else's.
  const training = (staffRosterId, staffName, signature) => admin("POST", "/train-track/records", {
    recordType: "internal", staffName, staffRosterId, trainingType: "Other", trainer: "Viewer Fixture",
    completedDate: today, siteId, signature,
  });
  const unsigned = await training(ownEntry.data?.id, "Read-only Viewer");
  const signedAlready = await training(ownEntry.data?.id, "Read-only Viewer", "data:image/png;base64,AAAA");
  const someoneElse = await training(otherEntry.data?.id, "Someone Else");
  check("training records seeded", [unsigned, signedAlready, someoneElse].every((r) => r.status === 201),
    [unsigned, signedAlready, someoneElse].map((r) => r.status).join(" "));
  const mine = await viewer("GET", "/train-track/my-records");
  expect("viewer lists their training", mine, [200]);
  const mineIds = new Set((mine.data?.records ?? []).map((r) => r.id));
  check("viewer sees their own records only",
    mine.data?.linked === true && mineIds.has(unsigned.data?.id) && mineIds.has(signedAlready.data?.id) && !mineIds.has(someoneElse.data?.id),
    JSON.stringify(mine.data)?.slice(0, 300));
  check("signatures themselves aren't sent back", (mine.data?.records ?? []).every((r) => !("signature" in r)));
  const signedNow = await viewer("POST", `/train-track/my-records/${unsigned.data?.id}/sign`, { signature: "data:image/png;base64,BBBB" });
  expect("viewer signs off their own record", signedNow, [200]);
  check("the record shows as signed", signedNow.data?.signed === true, JSON.stringify(signedNow.data));
  expect("a signed record can't be signed again",
    await viewer("POST", `/train-track/my-records/${signedAlready.data?.id}/sign`, { signature: "data:image/png;base64,CCCC" }), [409]);
  expect("viewer can't sign someone else's record",
    await viewer("POST", `/train-track/my-records/${someoneElse.data?.id}/sign`, { signature: "data:image/png;base64,CCCC" }), [404]);
  expect("a signature is required", await viewer("POST", `/train-track/my-records/${unsigned.data?.id}/sign`, {}), [400]);
  expect("staff and owners don't use the Viewer list", await admin("GET", "/train-track/my-records"), [403]);

  // One record per module family. `edit` is the body a member of staff could
  // send with `editMethod`; viewers must get 403 for it, for create and, where
  // the record type has a DELETE route, for DELETE.
  const atSite = `?siteId=${siteId}`;
  const greenMachine = await admin("POST", "/green-track/machines", { name: `Viewer mower ${suffix}`, type: "walk_behind" });
  const room = await admin("POST", "/room-track/rooms", { roomNumber: `VIEW-${suffix}`, name: "Viewer suite", floor: "1", siteId });
  const families = [
    { family: "FireTrack check", path: "/fire-safety",
      body: { checkType: "alarm", callPoint: "CP1", checkDate: today, result: "pass", performedBy: "Viewer Fixture", siteId }, edit: { notes: "viewer edit" } },
    { family: "Legionella check", path: "/legionella",
      body: { checkType: "calorifier_temp", checkDate: today, result: "pass", temperature: 60, performedBy: "Viewer Fixture", siteId },
      edit: { notes: "viewer edit" } },
    { family: "Legionella outlet", path: "/legionella/outlets", body: { name: `Viewer outlet ${suffix}`, type: "hot", siteId },
      edit: { name: "viewer edit" } },
    { family: "HotTub check", path: "/hot-tub",
      body: { checkType: "water_chemistry", checkDate: today, result: "pass", phValue: 7.4, sanitiserLevel: 2, performedBy: "Viewer Fixture", siteId },
      edit: { notes: "viewer edit" } },
    { family: "TreeTrack inspection", path: "/tree-track",
      body: { checkType: "visual_assessment", checkDate: today, result: "pass", treeRef: "VIEW-1", inspector: "Viewer Fixture", siteId },
      edit: { notes: "viewer edit" } },
    { family: "PoolTrack check", path: "/pool-track",
      body: { checkDate: today, checkType: "routine", result: "pass", performedBy: "Viewer Fixture", phLevel: 7.4, siteId },
      edit: { notes: "viewer edit" } },
    { family: "SwimTrack surveillance", path: "/swim-track/surveillance",
      body: { checkDate: today, checkTime: "10:00", scanCompleted: true, siteId }, edit: { notes: "viewer edit" } },
    { family: "GreenTrack defect", path: "/green-track/defects",
      body: { machineId: greenMachine.data?.id, reportDate: today, description: "Viewer defect", severity: "low", siteId },
      edit: { description: "viewer edit" } },
    { family: "BikeTrack bike", path: "/bike-track/bikes", body: { ref: `VIEW-BIKE-${suffix}`, type: "hybrid" },
      edit: { ref: "viewer edit", type: "hybrid" } },
    { family: "KitchenTrack food diary", path: "/food-safety", deletable: false, body: { recordDate: today, siteId }, edit: { correctives: "viewer edit" } },
    { family: "KitchenTrack probe check", path: "/kitchen-weekly/probe", list: `/kitchen-weekly/probe${atSite}`, deletable: false,
      body: { checkDate: today, probes: [{ name: "Probe A", iceTemp: "0.2", accurateIce: true }], overallResult: "pass", checkedBy: "Viewer Fixture", siteId },
      edit: { checkedBy: "viewer edit" } },
    { family: "KitchenTrack cleaning task", path: "/kitchen-cleaning/tasks",
      body: { area: "Viewer area", task: "Wipe down", frequency: "daily", siteId }, edit: { task: "viewer edit" } },
    { family: "DailyTrack AM checklist", path: "/daily-track-am", list: `/daily-track-am${atSite}`,
      body: { checklistType: "kitchen_opening", checkDate: today, items: [], siteId }, edit: { managerNote: "viewer edit" } },
    { family: "DailyTrack PM sign-off", path: "/daily-track-pm/signoffs", list: `/daily-track-pm/signoffs${atSite}`,
      body: { signoffDate: today, managerName: "Viewer Fixture", siteId }, edit: { notes: "viewer edit" } },
    { family: "IncidentTrack incident", path: "/incidents",
      body: { incidentDate: today, location: "Viewer room", description: "Viewer incident", involvedName: "Viewer Fixture",
        reportedBy: "Viewer Fixture", riddorRationale: "Viewer fixture: not reportable", siteId },
      edit: { description: "viewer edit" } },
    { family: "PatTrack appliance", path: "/pat-track/appliances",
      body: { name: `Viewer kettle ${suffix}`, applianceType: "Kettle", siteId },
      edit: { name: "viewer edit", applianceType: "Kettle", siteId } },
    { family: "PestTrack visit", path: "/pest-track/visits",
      body: { visitDate: today, contractorName: "Viewer Pest Control", findings: "none", siteId }, edit: { findings: "viewer edit" } },
    { family: "PremisesTrack inspection", path: "/premises-track",
      body: { inspectionDate: today, nextInspectionDate: iso(30), inspectionType: "routine", area: "Viewer area",
        findings: "None", status: "actioned", inspectedBy: "Viewer Fixture", siteId },
      edit: { findings: "viewer edit" } },
    { family: "RoomTrack check", path: "/room-track/checks", deletable: false,
      body: { roomId: room.data?.id, siteId, checkDate: today, clean: true, tidy: true, toStandard: true, notes: "Viewer Fixture" },
      edit: { notes: "viewer edit" } },
    { family: "COSHH register item", path: "/registers/coshh", body: { siteId, productName: `Viewer cleaner ${suffix}` },
      edit: { siteId, productName: "viewer edit" } },
    { family: "COSHH assessment", path: "/coshh-track/assessments",
      body: { siteId, task: `Viewer cleaning ${suffix}`, riskLevel: "low", assessmentDate: today },
      edit: { siteId, task: "viewer edit", riskLevel: "low", assessmentDate: today } },
    { family: "COSHH check", path: "/coshh-track/checks",
      body: { siteId, checkType: "staff_briefing", checkDate: today, subject: "Viewer Fixture", result: "pass" },
      edit: { siteId, checkType: "staff_briefing", checkDate: today, subject: "viewer edit", result: "pass" } },
    { family: "SafeTrack training record", path: "/safe-track/training-records",
      body: { staffName: "Viewer Fixture", trainingType: "Manual handling", completedAt: today, siteId }, edit: { staffName: "viewer edit" } },
    { family: "TrainTrack record", path: "/train-track/records", editMethod: "PATCH",
      body: { recordType: "certificate", staffName: "Viewer Fixture", trainingType: "Other", provider: "Viewer Fixture",
        completedDate: today, expiryDate: iso(30), siteId },
      edit: { notes: "viewer edit" } },
    { family: "FixTrack issue", path: "/fix-track/issues",
      body: { title: `Viewer issue ${suffix}`, issueType: "general", location: "Plant room", description: "Viewer fixture",
        priority: "medium", reportedBy: "Facilities", reportedDate: today, siteId },
      edit: { description: "viewer edit" } },
    { family: "Track action", path: "/track-actions", list: "/track-actions?module=fire", editMethod: "PATCH", deletable: false,
      body: { module: "fire", title: `Viewer action ${suffix}`, severity: "monitor", siteId }, edit: { ownerName: "viewer edit" } },
    { family: "Staff task", path: "/tasks", list: "/tasks?scope=all", editMethod: "PATCH", deletable: false,
      body: { title: `Viewer task ${suffix}`, recurrence: "once", startsOn: today, assigneeRole: "client_staff", siteId },
      edit: { title: "viewer edit" } },
  ];

  const recordIds = new Map();
  for (const { family, path, list = path, body, edit, editMethod = "PUT", deletable = true } of families) {
    const seeded = await admin("POST", path, body);
    let id = seeded.data?.id ?? seeded.data?.task?.id;
    if (!Number.isInteger(id) && [200, 201].includes(seeded.status)) {
      id = Math.max(...rowsOf((await admin("GET", list)).data).map(idOf).filter(Number.isInteger));
    }
    check(`${family}: seeded`, [200, 201].includes(seeded.status) && Number.isInteger(id),
      `${seeded.status} ${JSON.stringify(seeded.data)?.slice(0, 200)}`);
    if (!Number.isInteger(id)) continue;
    recordIds.set(path, id);
    const before = rowsOf((await admin("GET", list)).data).find((row) => idOf(row) === id);

    expect(`${family}: viewer can't read the list`, await viewer("GET", list), [403]);
    expect(`${family}: viewer create is refused`, await viewer("POST", path, body), [403]);
    expect(`${family}: viewer ${editMethod} is refused`, await viewer(editMethod, `${path}/${id}`, edit), [403]);
    if (deletable) expect(`${family}: viewer DELETE is refused`, await viewer("DELETE", `${path}/${id}`), [403]);
    const after = rowsOf((await admin("GET", list)).data).find((row) => idOf(row) === id);
    check(`${family}: record unchanged`, before !== undefined && JSON.stringify(after) === JSON.stringify(before),
      `before ${JSON.stringify(before)?.slice(0, 160)} after ${JSON.stringify(after)?.slice(0, 160)}`);
  }

  // Shared screens are closed to a viewer too.
  for (const path of ["/sites", `/sites/${siteId}`, "/dashboard/summary", "/compliance-items", `/calendar?from=${iso(-7)}&to=${iso(30)}`,
    "/users", "/settings", "/staff-roster", "/train-track/records", "/billing/config"]) {
    expect(`viewer can't read ${path}`, await viewer("GET", path), [403]);
  }
  const siteBefore = (await admin("GET", `/sites/${siteId}`)).data;
  expect("Sites: viewer PATCH is refused", await viewer("PATCH", `/sites/${siteId}`, { name: "viewer edit" }), [403]);
  expect("Sites: viewer DELETE is refused", await viewer("DELETE", `/sites/${siteId}`), [403]);
  check("Sites: site unchanged", JSON.stringify((await admin("GET", `/sites/${siteId}`)).data) === JSON.stringify(siteBefore));

  // Every guarded mutation route. Ids are filled with a seeded record where the
  // route's collection has one; the body is empty, since the guard must answer
  // before any validation. The lock middleware answers a viewer's write to a
  // record that does not exist on unscoped tracks with 404 "Record not found"
  // before the route runs; that is accepted only for placeholder ids.
  const routes = guardedRoutes();
  check("route sweep found the guarded routes", routes.length > 250, `found ${routes.length}`);
  const placeholder = "2000000000";
  let notFound = 0;
  for (const route of routes) {
    // The writes a viewer makes: signing their own records, checked above, and
    // signing a COSHH assessment for their site (tests/coshh-track.mjs).
    if (route.path === "/train-track/my-records/:id/sign" || route.path === "/train-track/my-coshh/:id/sign") continue;
    let usedPlaceholder = false;
    const collection = route.path.replace(/\/:[^/]+.*$/, "");
    const path = route.path.replace(/:(\w+)(\([^)]*\))?\??/g, (_match, param) => {
      if (param === "siteId") return String(siteId);
      if (param === "date") return today;
      if (["id"].includes(param) && recordIds.has(collection)) return String(recordIds.get(collection));
      usedPlaceholder = true;
      return placeholder;
    }).replace(/\*/g, "x");
    const result = await viewer(route.method, path, {});
    const missing = usedPlaceholder && result.status === 404 && result.data?.error === "Record not found";
    if (missing) notFound++;
    check(`sweep: viewer ${route.method} ${route.path} (${route.where}) is refused`, result.status === 403 || missing,
      `${path} got ${result.status} ${JSON.stringify(result.data)?.slice(0, 160)}`);
  }
  console.log(`Swept ${routes.length} guarded mutation routes as a viewer (${notFound} answered as a missing record).`);

  console.log(`viewer-read-only: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
