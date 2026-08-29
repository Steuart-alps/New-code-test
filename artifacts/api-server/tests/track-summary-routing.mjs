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
    { hot_tub: [2], kitchen: [3] },
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
    { hot_tub: [1], kitchen: [1] },
  );
  assert.equal(deduplicated.length, 1, "does not duplicate a senior manager also assigned to a track");
  assert.equal(deduplicated[0].actions.length, 2, "does not duplicate actions in the combined digest");
  assert.deepEqual(deduplicated[0].userIds, [1], "keeps one push recipient");

  const managerOnly = buildTrackSummaryRecipients(
    actions,
    [],
    [],
    [{ id: 2, email: "housekeeping@example.com" }],
    { hot_tub: [2] },
  );
  assert.equal(managerOnly.length, 1, "configured manager still receives their track when no senior email exists");
  assert.deepEqual(managerOnly[0].actions, [actions[0]]);

  const digest = buildTrackActionDigest([actions[0]], "https://example.test");
  assert.match(digest.html, /TubTrack/, "uses the customer-facing track label");
  assert.match(digest.html, /https:\/\/example\.test\/hot-tub/, "links to the relevant module");
  assert.equal(trackActionModuleUrl("unknown", "https://example.test/"), "https://example.test/dashboard");

  console.log("Track summary routing tests passed");
} finally {
  await rm(outDir, { recursive: true, force: true });
}