import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(tmpdir(), "kitchen-dashboard-status-"));
const outfile = path.join(tempDir, "status.mjs");

try {
  await build({
    entryPoints: [new URL("../src/lib/kitchen-dashboard-status.ts", import.meta.url).pathname],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
  });

  const { summarizeKitchenStatuses } = await import(`${new URL(`file://${outfile}`).href}?t=${Date.now()}`);

  assert.deepEqual(
    summarizeKitchenStatuses(["ok", "due_soon", "overdue", "never"]),
    { overdue: 1, dueSoon: 1, ok: 1, never: 1, tone: "overdue", label: "1 overdue" },
  );
  assert.equal(summarizeKitchenStatuses(["ok", "due_soon"]).tone, "due_soon");
  assert.equal(summarizeKitchenStatuses(["ok", "ok"]).label, "All clear");
  assert.equal(summarizeKitchenStatuses(["never", "ok"]).tone, "never");

  const dashboardSource = await readFile(
    new URL("../src/pages/dashboard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboardSource,
    /track\.trackId === "kitchen" \? <KitchenTrackStatusPill \/>/,
    "KitchenTrack status pill must be mounted on the actual kitchen dashboard row",
  );
  assert.match(
    dashboardSource,
    /apiFetch\("\/food-safety\/status"\)/,
    "KitchenTrack status pill must fetch the food-safety status endpoint",
  );

  console.log("Kitchen dashboard status tests passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}