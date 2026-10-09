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
  const { monthDayStatuses } = await import(pathToFileURL(outfile).href);
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
  const overview = selected => monthDayStatuses("2025-04", "2025-04-14", selected, checklists, signoffs);
  const day = (selected, number) => overview(selected)[number - 1];

  assert.deepEqual(day(sites, 10), { date: "2025-04-10", status: "complete", submitted: 10, started: 10 });
  assert.deepEqual(day(sites, 11), { date: "2025-04-11", status: "partial", submitted: 1, started: 2 });
  assert.deepEqual(day(sites, 12), { date: "2025-04-12", status: "missing", submitted: 0, started: 0 });
  assert.deepEqual(day(sites, 13), { date: "2025-04-13", status: "partial", submitted: 5, started: 5 });
  assert.deepEqual(day([sites[1]], 13), { date: "2025-04-13", status: "complete", submitted: 5, started: 5 });
  assert.deepEqual(day([sites[0]], 11), { date: "2025-04-11", status: "partial", submitted: 0, started: 1 });
  assert.deepEqual(day([sites[0]], 13), { date: "2025-04-13", status: "missing", submitted: 0, started: 0 });
  assert.equal(day(sites, 15).status, "future");
  assert.equal(day([], 10).status, "missing");
  console.log("DailyTrack month status, site filtering and draft checks passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}