// FixTrack priority board: column order and days past target.
// Bundled and run by tests/fix-track-board.test.mjs under TZ=Europe/London.
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FixTrackBoard,
  buildBoardColumns,
  daysPastTarget,
  elapsedDays,
  type BoardIssue,
} from "@/components/fix-track-board";

const results: string[] = [];
function test(name: string, run: () => void) {
  run();
  results.push(name);
}

let nextId = 1;
const issue = (overrides: Partial<BoardIssue>): BoardIssue => ({
  id: nextId++,
  title: `Issue ${nextId}`,
  issueType: "general",
  priority: "medium",
  status: "reported",
  reportedDate: "2026-03-01",
  targetDate: null,
  isOverdue: false,
  ...overrides,
});
const meta = { label: "x", color: "" };
const render = (issues: BoardIssue[], now: Date) => renderToStaticMarkup(
  <FixTrackBoard
    issues={issues}
    onEdit={() => {}}
    issueTypeMeta={(key) => ({ label: key, color: "" })}
    priorities={{ urgent: meta, high: meta, medium: meta, low: meta }}
    statuses={{ reported: meta, in_progress: meta }}
    now={now}
  />,
);
const columnOrder = (html: string) => [...html.matchAll(/data-trade="([^"]+)"/g)].map((m) => m[1]);
const cardOrder = (html: string) => [...html.matchAll(/data-issue-id="(\d+)"/g)].map((m) => Number(m[1]));
const at = (isoLocal: string) => new Date(isoLocal); // local wall-clock time in Europe/London

test("runs in the UK time zone", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Europe/London");
});

// ── Column order ─────────────────────────────────────────────────────────────
// API order deliberately differs from the expected severity order.
const mixed = [
  issue({ issueType: "general", priority: "low", reportedDate: "2026-01-02" }),
  issue({ issueType: "plumbing", priority: "medium", reportedDate: "2026-02-01" }),
  issue({ issueType: "electrical", priority: "high", reportedDate: "2026-02-10" }),
  issue({ issueType: "general", priority: "medium", reportedDate: "2026-01-05" }),
  issue({ issueType: "roofing", priority: "urgent", reportedDate: "2026-02-20" }),
  issue({ issueType: "plumbing", priority: "urgent", reportedDate: "2026-02-15" }),
  issue({ issueType: "electrical", priority: "low", reportedDate: "2025-12-01" }),
  issue({ issueType: "heating", priority: "high", reportedDate: "2026-02-10" }),
  issue({ issueType: "carpentry", priority: "urgent", reportedDate: "2026-02-28", status: "resolved" }),
  issue({ issueType: "glazing", priority: "high", reportedDate: "2026-01-01", status: "closed" }),
];

test("columns ordered by highest open priority, then oldest job at that priority", () => {
  assert.deepEqual(buildBoardColumns(mixed).map((c) => c.key), [
    "plumbing",   // urgent, 15 Feb
    "roofing",    // urgent, 20 Feb
    "electrical", // high, 10 Feb (tie on date with heating → key order)
    "heating",    // high, 10 Feb
    "general",    // medium
  ]);
});

test("equally urgent groups keep a stable order whatever the API order", () => {
  const reversed = [...mixed].reverse();
  assert.deepEqual(buildBoardColumns(reversed).map((c) => c.key), buildBoardColumns(mixed).map((c) => c.key));
});

test("an older low job does not lift its column above a more urgent one", () => {
  const electrical = buildBoardColumns(mixed).findIndex((c) => c.key === "electrical");
  const plumbing = buildBoardColumns(mixed).findIndex((c) => c.key === "plumbing");
  assert.ok(plumbing < electrical);
});

test("open-only grouping: resolved and closed issues form no column", () => {
  const keys = buildBoardColumns(mixed).map((c) => c.key);
  assert.ok(!keys.includes("carpentry") && !keys.includes("glazing"));
  assert.equal(buildBoardColumns(mixed).flatMap((c) => c.items).length, 8);
});

test("card order inside a column is unchanged: priority, then oldest reported", () => {
  const general = buildBoardColumns(mixed).find((c) => c.key === "general")!;
  assert.deepEqual(general.items.map((i) => i.priority), ["medium", "low"]);
  const electrical = buildBoardColumns(mixed).find((c) => c.key === "electrical")!;
  assert.deepEqual(electrical.items.map((i) => i.priority), ["high", "low"]);
});

test("rendered board shows columns in severity order", () => {
  const html = render(mixed, at("2026-03-01T12:00:00"));
  assert.deepEqual(columnOrder(html), ["plumbing", "roofing", "electrical", "heating", "general"]);
  const plumbing = buildBoardColumns(mixed)[0].items.map((i) => i.id);
  assert.deepEqual(cardOrder(html).slice(0, 2), plumbing);
});

test("no open issues → empty state", () => {
  assert.match(render([issue({ status: "resolved" })], new Date()), /No open issues/);
});

// ── Days past target ─────────────────────────────────────────────────────────
const now = at("2026-06-10T09:30:00");

test("due today is not past target", () => {
  const due = issue({ targetDate: "2026-06-10", isOverdue: false });
  assert.equal(daysPastTarget(due, now), null);
  assert.doesNotMatch(render([due], now), /past target/);
});

test("first overdue day shows 1 day past target", () => {
  const late = issue({ targetDate: "2026-06-09", isOverdue: true });
  assert.equal(daysPastTarget(late, now), 1);
  assert.match(render([late], now), />1 day past target</);
});

test("several days past target", () => {
  assert.match(render([issue({ targetDate: "2026-06-01", isOverdue: true })], now), />9 days past target</);
});

test("future target shows nothing", () => {
  const future = issue({ targetDate: "2026-06-20", isOverdue: false });
  assert.equal(daysPastTarget(future, now), null);
  assert.doesNotMatch(render([future], now), /past target/);
});

test("missing target keeps the no-target label and shows nothing past target", () => {
  const html = render([issue({ targetDate: null, isOverdue: false })], now);
  assert.match(html, /No target date/);
  assert.doesNotMatch(html, /past target/);
});

test("not overdue per the server → no past-target label even if the date has passed locally", () => {
  assert.equal(daysPastTarget(issue({ targetDate: "2026-06-09", isOverdue: false }), now), null);
});

test("the reported-age label is kept alongside", () => {
  const html = render([issue({ reportedDate: "2026-06-01", targetDate: "2026-06-05", isOverdue: true })], now);
  assert.match(html, />9 days open</);
  assert.match(html, />5 days past target</);
  assert.match(html, /Overdue/);
});

// ── UK daylight saving ───────────────────────────────────────────────────────
// Clocks go forward 29 Mar 2026 (23-hour day) and back 25 Oct 2026 (25-hour day).
test("spring forward: one calendar day across the 23-hour day", () => {
  const late = issue({ targetDate: "2026-03-29", isOverdue: true, reportedDate: "2026-03-29" });
  const morning = at("2026-03-30T00:30:00");
  assert.equal(daysPastTarget(late, morning), 1);
  assert.equal(elapsedDays("2026-03-29", morning), 1);
  assert.match(render([late], morning), />1 day past target</);
});

test("autumn back: one calendar day across the 25-hour day", () => {
  const late = issue({ targetDate: "2026-10-25", isOverdue: true });
  assert.equal(daysPastTarget(late, at("2026-10-26T00:10:00")), 1);
  assert.equal(daysPastTarget(late, at("2026-10-26T23:50:00")), 1);
});

test("a span across both changes counts calendar days", () => {
  assert.equal(daysPastTarget(issue({ targetDate: "2026-03-01", isOverdue: true }), at("2026-11-01T08:00:00")), 245);
});

console.log(`${results.length} FixTrack board checks passed`);
