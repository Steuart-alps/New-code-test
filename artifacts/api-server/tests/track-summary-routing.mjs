import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-track-routing-"));
const outFile = path.join(outDir, "entry.mjs");

try {
  await build({
    entryPoints: [path.join(testsDir, "track-summary-routing.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);`,
    },
  });

  const {
    buildTrackSummaryRecipients,
    buildTrackActionDigest,
    trackActionModuleUrl,
    parseTrackSummaryRouting,
    effectiveTrackRouting,
  } = await import(pathToFileURL(outFile).href);

  const actions = [
    { module: "hot_tub", title: "Check chlorine", owner_name: null, due_date: "2026-08-30", severity: "urgent" },
    { module: "kitchen", title: "Record fridge temperature", owner_name: "Alex", due_date: null, severity: "action_required" },
  ];
  const recipients = buildTrackSummaryRecipients(
    actions,
    ["senior@example.com"],
    [{ id: 1, email: "senior@example.com" }],
    [
      { id: 2, email: "housekeeping@example.com" },
      { id: 3, email: "kitchen@example.com" },
    ],
    { hot_tub: { managerIds: [2], departmentIds: [] }, kitchen: { managerIds: [3], departmentIds: [] } },
  );

  assert.equal(recipients.length, 3, "creates one digest per unique recipient");
  assert.deepEqual(
    recipients.find((recipient) => recipient.email === "senior@example.com")?.actions,
    actions,
    "senior manager receives every track",
  );
  assert.deepEqual(
    recipients.find((recipient) => recipient.email === "housekeeping@example.com")?.actions,
    [actions[0]],
    "department manager receives only the assigned track",
  );
  assert.deepEqual(
    recipients.find((recipient) => recipient.email === "kitchen@example.com")?.actions,
    [actions[1]],
    "different department managers receive separate track summaries",
  );

  const deduplicated = buildTrackSummaryRecipients(
    actions,
    ["SENIOR@example.com"],
    [{ id: 1, email: "senior@example.com" }],
    [{ id: 1, email: "senior@example.com" }],
    { hot_tub: { managerIds: [1], departmentIds: [] }, kitchen: { managerIds: [1], departmentIds: [] } },
  );
  assert.equal(deduplicated.length, 1, "does not duplicate a senior manager also assigned to a track");
  assert.equal(deduplicated[0].actions.length, 2, "does not duplicate actions in the combined digest");
  assert.deepEqual(deduplicated[0].userIds, [1], "keeps one push recipient");

  const managerOnly = buildTrackSummaryRecipients(
    actions,
    [],
    [],
    [{ id: 2, email: "housekeeping@example.com" }],
    { hot_tub: { managerIds: [2], departmentIds: [] } },
  );
  assert.equal(managerOnly.length, 1, "configured manager still receives their track when no senior email exists");
  assert.deepEqual(managerOnly[0].actions, [actions[0]]);

  const defaults = effectiveTrackRouting({}, [
    { id: 10, name: "Housekeeping" },
    { id: 11, name: "Maintenance" },
    { id: 12, name: "Kitchen" },
  ], ["hot_tub", "kitchen", "fire"]);
  assert.deepEqual(defaults.hot_tub.departmentIds, [10, 11], "TubTrack defaults to housekeeping and maintenance");
  assert.deepEqual(defaults.kitchen.departmentIds, [12], "KitchenTrack defaults to kitchen");
  const overridden = effectiveTrackRouting({ hot_tub: { managerIds: [], departmentIds: [] } }, [
    { id: 10, name: "Housekeeping" },
  ], ["hot_tub"]);
  assert.deepEqual(overridden.hot_tub.departmentIds, [], "explicit empty assignment disables default recipients");

  const scopedActions = [
    { ...actions[0], site_department_id: 10 },
    { ...actions[1], module: "hot_tub", site_department_id: 11 },
    { ...actions[0], title: "Unassigned-site action", site_department_id: null },
  ];
  const scoped = buildTrackSummaryRecipients(scopedActions, ["senior@example.com"], [],
    [
      { id: 2, email: "housekeeping@example.com", role: "client_staff", departmentId: 10, isDepartmentManager: true },
      { id: 3, email: "maintenance@example.com", role: "client_staff", departmentId: 11, isMaintenanceManager: true },
      { id: 4, email: "ordinary@example.com", role: "client_staff", departmentId: 10 },
    ], { hot_tub: { managerIds: [], departmentIds: [10, 11] } }, ["hot_tub"]);
  assert.equal(scoped.find((recipient) => recipient.email === "senior@example.com").actions.length, 3);
  assert.deepEqual(scoped.find((recipient) => recipient.email === "housekeeping@example.com").actions,
    [scopedActions[0], scopedActions[2]], "department manager sees own-site and unassigned actions");
  assert.deepEqual(scoped.find((recipient) => recipient.email === "maintenance@example.com").actions,
    [scopedActions[1], scopedActions[2]], "other department details stay private");
  assert.ok(!scoped.some((recipient) => recipient.email === "ordinary@example.com"),
    "ordinary department staff never receive automatic manager summaries");

  const noActions = buildTrackSummaryRecipients([], ["senior@example.com"], [], [
    { id: 2, email: "housekeeping@example.com", role: "client_staff", departmentId: 10, isDepartmentManager: true },
  ], { hot_tub: { managerIds: [], departmentIds: [10] } }, ["hot_tub", "kitchen"]);
  assert.deepEqual(noActions.map((recipient) => recipient.modules),
    [["hot_tub", "kitchen"], ["hot_tub"]], "senior sees all enabled tracks; manager sees relevant track with no actions");
  assert.deepEqual(parseTrackSummaryRouting('{"hot_tub":[2],"other":[99]}'),
    { hot_tub: { managerIds: [2], departmentIds: [] } }, "legacy named assignments remain readable");

  const digest = buildTrackActionDigest([actions[0]], "https://example.test");
  assert.match(digest.html, /TubTrack/, "uses the customer-facing track label");
  assert.match(digest.html, /https:\/\/example\.test\/hot-tub/, "links to the relevant module");
  const emptyDigest = buildTrackActionDigest([], "https://example.test", ["hot_tub", "kitchen"]);
  assert.match(emptyDigest.text, /KitchenTrack: 0 outstanding/);
  assert.match(emptyDigest.html, /No outstanding actions/);
  assert.equal(trackActionModuleUrl("unknown", "https://example.test/"), "https://example.test/dashboard");

  console.log("Track summary routing tests passed");
} finally {
  await rm(outDir, { recursive: true, force: true });
}