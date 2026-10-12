import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const tempDir = await mkdtemp(path.join(tmpdir(), "kitchen-dashboard-status-"));
const outfile = path.join(tempDir, "status.mjs");

try {
  // Bundle the real summary logic and pill component together with
  // react-dom/server so the test renders exactly what the dashboard renders.
  await build({
    stdin: {
      contents: `
        export { summarizeKitchenStatuses } from "./src/lib/kitchen-dashboard-status.ts";
        export { KitchenStatusPill, KITCHEN_PILL_CLASS } from "./src/components/kitchen-status-pill.tsx";
        export { createElement } from "react";
        export { renderToStaticMarkup } from "react-dom/server";
      `,
      resolveDir: packageDir,
      loader: "ts",
    },
    tsconfig: path.join(packageDir, "tsconfig.json"),
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "silent",
  });

  const {
    summarizeKitchenStatuses,
    KitchenStatusPill,
    KITCHEN_PILL_CLASS,
    createElement,
    renderToStaticMarkup,
  } = await import(`${new URL(`file://${outfile}`).href}?t=${Date.now()}`);

  const renderPill = (statuses) => renderToStaticMarkup(createElement(KitchenStatusPill, { statuses }));
  // The coloured pill is the first inner <span>; return its class and text.
  const pillOf = (statuses) => {
    const match = renderPill(statuses).match(/^<span class="inline-flex[^"]*"><span class="([^"]*)">([^<]*)<\/span>/);
    assert.ok(match, `Expected a rendered pill for ${JSON.stringify(statuses)}`);
    return { className: match[1], label: match[2] };
  };
  const countsOf = (statuses) => renderPill(statuses).match(/aria-label="([^"]*)"/)?.[1];

  // ── Overdue takes priority over due soon ───────────────────────────────────
  for (const statuses of [
    ["ok", "due_soon", "overdue", "never"],
    ["due_soon", "due_soon", "due_soon", "overdue"],
    ["overdue", "due_soon"],
    ["never", "never", "overdue"],
  ]) {
    const summary = summarizeKitchenStatuses(statuses);
    assert.equal(summary.tone, "overdue", `overdue must win for ${JSON.stringify(statuses)}`);
    const pill = pillOf(statuses);
    assert.match(pill.label, /^\d+ overdue$/, `pill must report overdue for ${JSON.stringify(statuses)}`);
    assert.match(pill.className, /\bbg-rose-100\b/);
    assert.match(pill.className, /\btext-rose-700\b/);
    assert.doesNotMatch(pill.className, /amber|emerald/, "an overdue pill must not be amber or green");
  }
  assert.deepEqual(
    summarizeKitchenStatuses(["ok", "due_soon", "overdue", "never"]),
    { overdue: 1, dueSoon: 1, ok: 1, never: 1, tone: "overdue", label: "1 overdue" },
  );
  assert.equal(pillOf(["overdue", "due_soon", "overdue", "due_soon", "due_soon"]).label, "2 overdue");
  assert.equal(
    countsOf(["overdue", "due_soon", "due_soon", "ok"]),
    "1 overdue, 2 due soon, 1 clear, 0 never recorded",
    "overdue priority must not hide the due-soon count",
  );

  // ── Due soon is amber ──────────────────────────────────────────────────────
  for (const statuses of [["due_soon"], ["ok", "due_soon", "ok"], ["never", "due_soon"]]) {
    assert.equal(summarizeKitchenStatuses(statuses).tone, "due_soon", `due soon expected for ${JSON.stringify(statuses)}`);
    const pill = pillOf(statuses);
    assert.equal(pill.label, "1 due soon");
    assert.match(pill.className, /\bbg-amber-100\b/);
    assert.match(pill.className, /\btext-amber-700\b/);
    assert.doesNotMatch(pill.className, /rose|emerald/, "a due-soon pill must not be red or green");
  }
  assert.equal(pillOf(["due_soon", "ok", "due_soon"]).label, "2 due soon");

  // ── All clear is green ─────────────────────────────────────────────────────
  for (const statuses of [["ok"], ["ok", "ok", "ok"]]) {
    assert.equal(summarizeKitchenStatuses(statuses).tone, "ok");
    const pill = pillOf(statuses);
    assert.equal(pill.label, "All clear");
    assert.match(pill.className, /\bbg-emerald-100\b/);
    assert.match(pill.className, /\btext-emerald-700\b/);
    assert.doesNotMatch(pill.className, /rose|amber/, "an all-clear pill must not be red or amber");
  }
  assert.equal(countsOf(["ok", "ok", "ok"]), "0 overdue, 0 due soon, 3 clear, 0 never recorded");

  // ── Never-recorded checks are not reported as clear ────────────────────────
  for (const statuses of [["never"], ["never", "never"], ["ok", "never", "ok"]]) {
    const summary = summarizeKitchenStatuses(statuses);
    assert.equal(summary.tone, "never", `never-recorded checks must not read as clear: ${JSON.stringify(statuses)}`);
    assert.equal(summary.ok, statuses.filter((s) => s === "ok").length, "never-recorded checks must not count as clear");
    const pill = pillOf(statuses);
    assert.notEqual(pill.label, "All clear");
    assert.match(pill.label, /^\d+ never recorded$/);
    assert.doesNotMatch(pill.className, /emerald/, "a never-recorded pill must not be green");
    assert.match(pill.className, /\bbg-muted\b/);
  }
  assert.equal(countsOf(["ok", "never", "never"]), "0 overdue, 0 due soon, 1 clear, 2 never recorded");
  // A site with no kitchen checks at all shows no pill rather than "All clear".
  assert.equal(renderPill([]), "");

  // Every tone has a distinct colour so a refactor cannot collapse two states.
  assert.equal(new Set(Object.values(KITCHEN_PILL_CLASS)).size, 4);

  // ── The pill sits on the KitchenTrack row, which links to the KitchenTrack page ──
  const dashboardSource = await readFile(new URL("../src/pages/dashboard.tsx", import.meta.url), "utf8");
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
  assert.match(
    dashboardSource,
    /return <KitchenStatusPill statuses=\{statuses\.map\(\(\{ status \}\) => status\)\} \/>/,
    "the dashboard must render the shared KitchenStatusPill tested above",
  );
  const trackRow = dashboardSource.match(/function TrackRow\([\s\S]*?\n}\n/)?.[0];
  assert.ok(trackRow, "TrackRow component not found in dashboard.tsx");
  const rowLink = trackRow.match(/<Link\s+href=\{track\.path\}[\s\S]*?<\/Link>/)?.[0];
  assert.ok(rowLink, "TrackRow header must be a Link to track.path");
  assert.match(rowLink, /\{kitchenOverdueBadge\}/, "the KitchenTrack pill must sit inside the row's link");

  const summarySource = await readFile(
    new URL("../../api-server/src/routes/dashboard-summary.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    summarySource,
    /trackId: "kitchen",\s*label: "KitchenTrack",\s*path: "\/kitchen",/,
    "the KitchenTrack dashboard row must link to /kitchen",
  );

  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(appSource, /<Route path="\/kitchen" component=\{KitchenPage\} \/>/, "/kitchen must route to the KitchenTrack page");
  assert.match(appSource, /import KitchenPage from "@\/pages\/kitchen"/, "KitchenPage must be the KitchenTrack page module");

  console.log("Kitchen dashboard status tests passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
