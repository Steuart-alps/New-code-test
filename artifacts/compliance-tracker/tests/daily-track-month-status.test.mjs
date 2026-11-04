import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "daily-month-status-"));
try {
  const outfile = path.join(dir, "status.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/daily-track-month-status.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
  });
  const { monthDayStatuses, siteDayStatuses, parseDailyTrackHistory } = await import(pathToFileURL(outfile).href);
  const ALL = ["kitchen_opening", "premises_opening", "kitchen_closing", "premises_closing", "signoff"];
  const sites = [{ id: 1 }, { id: 2 }];
  const types = ["kitchen_opening", "premises_opening", "kitchen_closing", "premises_closing"];
  const checklist = (date, siteId, checklistType, submitted = true) => ({
    checkDate: date, siteId, checklistType,
    submittedAt: submitted ? "2025-04-10T12:00:00.000Z" : null,
  });
  const signoff = (date, siteId, submitted = true) => ({
    signoffDate: date, siteId,
    submittedAt: submitted ? "2025-04-10T12:00:00.000Z" : null,
  });
  const complete = types.map(type => checklist("2025-04-10", 1, type));
  const checklists = [
    ...complete, ...types.map(type => checklist("2025-04-10", 2, type)),
    checklist("2025-04-11", 1, "kitchen_opening", false),
    checklist("2025-04-11", 2, "premises_opening"),
    checklist("2025-04-11", 2, "premises_opening"), // duplicate cannot fill another requirement
    checklist("2025-04-12", null, "kitchen_opening"),
    checklist("2025-04-12", 1, "unknown_checklist"),
    ...types.map(type => checklist("2025-04-13", 2, type)),
  ];
  const signoffs = [
    signoff("2025-04-10", 1), signoff("2025-04-10", 2),
    signoff("2025-04-13", 2),
  ];
  const history = (requirements, rows = checklists, signs = signoffs) => ({ requirements, checklists: rows, signoffs: signs });
  const overview = (selected, requirements = ALL, rows, signs) =>
    monthDayStatuses("2025-04", "2025-04-14", selected, history(requirements, rows, signs));
  const day = (selected, number, requirements, rows, signs) => overview(selected, requirements, rows, signs)[number - 1];

  // Every service: five checks per site.
  assert.deepEqual(day(sites, 10), { date: "2025-04-10", status: "complete", submitted: 10, started: 10, expected: 10 });
  assert.deepEqual(day(sites, 11), { date: "2025-04-11", status: "partial", submitted: 1, started: 2, expected: 10 });
  assert.deepEqual(day(sites, 12), { date: "2025-04-12", status: "missing", submitted: 0, started: 0, expected: 10 });
  assert.deepEqual(day(sites, 13), { date: "2025-04-13", status: "partial", submitted: 5, started: 5, expected: 10 });
  assert.deepEqual(day([sites[1]], 13), { date: "2025-04-13", status: "complete", submitted: 5, started: 5, expected: 5 });
  assert.deepEqual(day([sites[0]], 11), { date: "2025-04-11", status: "partial", submitted: 0, started: 1, expected: 5 });
  assert.deepEqual(day([sites[0]], 13), { date: "2025-04-13", status: "missing", submitted: 0, started: 0, expected: 5 });
  assert.equal(day(sites, 15).status, "future");
  assert.equal(day([], 10).status, "missing");

  // A draft and a submitted copy of the same check count once, as submitted.
  const draftThenSubmitted = [checklist("2025-04-02", 1, "kitchen_opening", false), checklist("2025-04-02", 1, "kitchen_opening")];
  assert.deepEqual(day([sites[0]], 2, ["kitchen_opening"], draftThenSubmitted, []),
    { date: "2025-04-02", status: "complete", submitted: 1, started: 1, expected: 1 });

  // KitchenTrack only: kitchen opening, kitchen closing and the sign-off.
  const kitchen = ["kitchen_opening", "kitchen_closing", "signoff"];
  const kitchenRows = [
    checklist("2025-04-03", 1, "kitchen_opening"), checklist("2025-04-03", 1, "kitchen_closing"),
    checklist("2025-04-04", 1, "kitchen_opening"), checklist("2025-04-04", 1, "kitchen_closing"),
    checklist("2025-04-05", 1, "premises_opening"), // left over from an earlier plan
  ];
  const kitchenSignoffs = [signoff("2025-04-03", 1), signoff("2025-04-04", 1, false)];
  assert.deepEqual(day([sites[0]], 3, kitchen, kitchenRows, kitchenSignoffs),
    { date: "2025-04-03", status: "complete", submitted: 3, started: 3, expected: 3 },
    "a KitchenTrack-only site goes green once its three checks are submitted");
  assert.deepEqual(day([sites[0]], 4, kitchen, kitchenRows, kitchenSignoffs),
    { date: "2025-04-04", status: "partial", submitted: 2, started: 3, expected: 3 },
    "a draft sign-off keeps the day amber");
  assert.deepEqual(day([sites[0]], 5, kitchen, kitchenRows, kitchenSignoffs),
    { date: "2025-04-05", status: "missing", submitted: 0, started: 0, expected: 3 },
    "checks outside the client's services neither start nor complete a day");

  // PremisesTrack only, across two sites.
  const premises = ["premises_opening", "premises_closing", "signoff"];
  const premisesRows = [1, 2].flatMap(siteId => [
    checklist("2025-04-07", siteId, "premises_opening"), checklist("2025-04-07", siteId, "premises_closing"),
  ]);
  assert.equal(day(sites, 7, premises, premisesRows, [signoff("2025-04-07", 1), signoff("2025-04-07", 2)]).status, "complete");
  assert.equal(day(sites, 7, premises, premisesRows, [signoff("2025-04-07", 1)]).status, "partial");

  // DailyTrack AM only: both openings, no PM checks and no sign-off.
  const amOnly = ["kitchen_opening", "premises_opening"];
  const amRows = [checklist("2025-04-08", 1, "kitchen_opening"), checklist("2025-04-08", 1, "premises_opening")];
  assert.deepEqual(day([sites[0]], 8, amOnly, amRows, [signoff("2025-04-08", 1, false)]),
    { date: "2025-04-08", status: "complete", submitted: 2, started: 2, expected: 2 },
    "a sign-off draft cannot start or block a day that expects no sign-off");

  // Day grid: one status per enabled requirement, nothing for the others.
  const grid = siteDayStatuses("2025-04-04", sites, history(kitchen, kitchenRows, kitchenSignoffs));
  assert.deepEqual(grid.get(1), { kitchen_opening: "submitted", kitchen_closing: "submitted", signoff: "draft" });
  assert.deepEqual(grid.get(2), { kitchen_opening: "none", kitchen_closing: "none", signoff: "none" });

  // Responses: unknown requirements are dropped and display order is fixed;
  // a body without the history shape is an error, not an empty month.
  assert.deepEqual(
    parseDailyTrackHistory({ requirements: ["signoff", "mystery", "kitchen_closing"], checklists: [], signoffs: [] }).requirements,
    ["kitchen_closing", "signoff"],
  );
  assert.throws(() => parseDailyTrackHistory({ checklists: [], signoffs: [] }));
  assert.throws(() => parseDailyTrackHistory(null));
  console.log("DailyTrack month status, partial subscription, site filtering and draft checks passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}