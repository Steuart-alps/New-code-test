import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

if (process.argv.includes("--verify")) {
  const { compareTrainingExpiry, getTrainingExpiry } = await import(pathToFileURL(process.env.EXPIRY_BUNDLE).href);
  const calendarDate = days => new Date(Date.UTC(2025, 2, 8 + days)).toISOString().slice(0, 10);
  const records = [
    { staffName: "No expiry", expiryDate: null },
    { staffName: "Thirty one", expiryDate: calendarDate(31) },
    { staffName: "Thirty", expiryDate: calendarDate(30) },
    { staffName: "Today", expiryDate: calendarDate(0) },
    { staffName: "Yesterday", expiryDate: calendarDate(-1) },
    { staffName: "Five", expiryDate: calendarDate(5) },
    { staffName: "Older overdue", expiryDate: calendarDate(-5) },
  ];
  for (const hour of [0, 12, 23]) {
    // Local dates are the contract even when UTC is already on another day.
    const today = new Date(2025, 2, 8, hour, hour === 23 ? 59 : 1);
    const state = record => getTrainingExpiry(record.expiryDate, today);
    assert.deepEqual(records.map(record => state(record).state), [
      "no_expiry", "current", "expiring_soon", "expiring_soon",
      "overdue", "expiring_soon", "overdue",
    ], `incorrect status in ${process.env.TZ} at ${hour}:00`);
    assert.deepEqual(records.map(record => state(record).days), [
      null, 31, 30, 0, -1, 5, -5,
    ], `incorrect calendar-day count in ${process.env.TZ} at ${hour}:00`);
    assert.deepEqual([...records].sort((a, b) => compareTrainingExpiry(a, b, today))
      .map(record => record.staffName), [
      "Older overdue", "Yesterday", "Today", "Five", "Thirty", "Thirty one", "No expiry",
    ]);
    assert.equal(records.filter(record => state(record).state === "overdue").length, 2);
    assert.equal(records.filter(record => state(record).state === "expiring_soon").length, 3);
  }
  const beforeMidnight = new Date(2025, 2, 8, 23, 59);
  const afterMidnight = new Date(2025, 2, 9, 0, 1);
  assert.equal(getTrainingExpiry(calendarDate(0), beforeMidnight).state, "expiring_soon");
  assert.equal(getTrainingExpiry(calendarDate(0), afterMidnight).state, "overdue");
  assert.equal(getTrainingExpiry(calendarDate(31), beforeMidnight).state, "current");
  assert.deepEqual(getTrainingExpiry(calendarDate(31), afterMidnight),
    { days: 30, state: "expiring_soon" });
  console.log(`${process.env.TZ} certificate expiry checks passed.`);
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await mkdtemp(path.join(os.tmpdir(), "training-expiry-"));
  const bundle = path.join(dir, "training-expiry.mjs");
  try {
    await build({
      entryPoints: [path.join(root, "src/lib/training-expiry.ts")],
      bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
    });
    for (const timezone of ["UTC", "America/Los_Angeles", "Europe/London", "Pacific/Auckland"]) {
      const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--verify"], {
        encoding: "utf8",
        env: { ...process.env, TZ: timezone, EXPIRY_BUNDLE: bundle },
      });
      process.stdout.write(output);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}