import assert from "node:assert/strict";
import test from "node:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildPriorityBoardColumns,
  elapsedBoardDays,
  FixTrackBoard,
  type BoardStatusMeta,
  type FixTrackBoardIssue,
} from "../../components/fix-track-board";

const fixedToday = new Date(2026, 5, 15, 23, 59);

function reportDate(daysAgo: number): string {
  const date = new Date(fixedToday.getFullYear(), fixedToday.getMonth(), fixedToday.getDate());
  date.setDate(date.getDate() - daysAgo);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function issue(
  id: number,
  issueType: string,
  priority: string,
  daysAgo: number,
  status = "reported",
  isOverdue = false,
): FixTrackBoardIssue {
  return {
    id,
    title: `Issue ${id}`,
    issueType,
    priority,
    status,
    reportedDate: reportDate(daysAgo),
    location: "Plant room",
    isOverdue,
  };
}

const priorityMeta = {
  urgent: { label: "Urgent", color: "text-red-700" },
  high: { label: "High", color: "text-amber-700" },
  medium: { label: "Medium", color: "text-blue-700" },
  low: { label: "Low", color: "text-slate-700" },
};
const statusMeta: Record<string, BoardStatusMeta> = {
  reported: { label: "Reported", color: "text-amber-700" },
  in_progress: { label: "In Progress", color: "text-blue-700" },
};
const issueTypeMeta = (key: string) => ({
  label: key === "electrical" ? "Electrical" : key === "plumbing" ? "Plumbing" : key,
  color: "text-slate-700",
});

interface BoardButtonProps {
  children?: ReactNode;
  "data-testid"?: string;
  onClick?: (event: unknown) => void;
}

function renderBoard(
  issues: FixTrackBoardIssue[],
  today: Date = fixedToday,
  onEdit: (issue: FixTrackBoardIssue) => void = () => undefined,
) {
  const tree = FixTrackBoard({ issues, today, onEdit, issueTypeMeta, priorities: priorityMeta, statuses: statusMeta });
  return { tree, markup: renderToStaticMarkup(tree) };
}

function buttonsIn(node: ReactNode): ReactElement<BoardButtonProps>[] {
  if (Array.isArray(node)) return node.flatMap(buttonsIn);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<BoardButtonProps>;
  const ownButton = element.type === "button" ? [element] : [];
  return [...ownButton, ...Children.toArray(element.props.children).flatMap(buttonsIn)];
}

function elementByTestId(node: ReactNode, testId: string): ReactElement<BoardButtonProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = elementByTestId(child, testId);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<BoardButtonProps>;
  if (element.props["data-testid"] === testId) return element;
  for (const child of Children.toArray(element.props.children)) {
    const found = elementByTestId(child, testId);
    if (found) return found;
  }
  return undefined;
}

test("the priority board includes only open issues and groups them by issue type", () => {
  const issues = [
    issue(4, "electrical", "low", 1),
    issue(2, "electrical", "urgent", 4, "in_progress"),
    issue(3, "electrical", "high", 9),
    issue(5, "plumbing", "medium", 2),
    issue(6, "mechanical", "urgent", 20, "resolved"),
    issue(7, "electrical", "urgent", 30, "closed"),
  ];

  const columns = buildPriorityBoardColumns(issues);
  assert.deepEqual(columns.map(column => column.key), ["electrical", "plumbing"]);
  assert.deepEqual(columns.map(column => column.items.map(item => item.id)), [[2, 3, 4], [5]]);

  const { tree, markup } = renderBoard(issues);
  assert.match(markup, /fix-track-board-column-electrical/);
  assert.match(markup, /fix-track-board-column-plumbing/);
  assert.doesNotMatch(markup, /fix-track-board-column-mechanical/);
  assert.doesNotMatch(markup, /Issue 6|Issue 7/);
  const electrical = elementByTestId(tree, "fix-track-board-column-electrical");
  const plumbing = elementByTestId(tree, "fix-track-board-column-plumbing");
  assert.ok(electrical);
  assert.ok(plumbing);
  assert.deepEqual(buttonsIn(electrical).map(button => button.props["data-testid"]), [
    "fix-track-board-card-2",
    "fix-track-board-card-3",
    "fix-track-board-card-4",
  ]);
  assert.deepEqual(buttonsIn(plumbing).map(button => button.props["data-testid"]), ["fix-track-board-card-5"]);
});

test("cards sort Urgent, High, Medium, Low and put the oldest issue first within each priority", () => {
  const issues = [
    issue(5, "electrical", "low", 1),
    issue(2, "electrical", "urgent", 5),
    issue(3, "electrical", "high", 7),
    issue(4, "electrical", "medium", 9),
    issue(1, "electrical", "urgent", 12),
  ];
  const columns = buildPriorityBoardColumns(issues);
  assert.deepEqual(columns[0].items.map(item => item.id), [1, 2, 3, 4, 5]);

  const { tree } = renderBoard(issues);
  assert.deepEqual(buttonsIn(tree).map(button => button.props["data-testid"]), [
    "fix-track-board-card-1",
    "fix-track-board-card-2",
    "fix-track-board-card-3",
    "fix-track-board-card-4",
    "fix-track-board-card-5",
  ]);
});

test("whole local-day counts and overdue labels render correctly at date boundaries", () => {
  assert.equal(elapsedBoardDays(reportDate(0), fixedToday), 0);
  assert.equal(elapsedBoardDays(reportDate(1), fixedToday), 1);
  assert.equal(elapsedBoardDays(reportDate(7), fixedToday), 7);
  assert.equal(elapsedBoardDays(reportDate(14), fixedToday), 14);
  assert.equal(elapsedBoardDays(reportDate(-1), fixedToday), 0, "a future report date must not show negative days");

  const afterSpringClockChange = new Date(2026, 2, 30, 12);
  assert.equal(elapsedBoardDays("2026-03-28", afterSpringClockChange), 2, "the 23-hour Sunday still counts as a full calendar day");
  const { markup: dstMarkup } = renderBoard([
    { ...issue(128, "electrical", "high", 0), reportedDate: "2026-03-28" },
  ], afterSpringClockChange);
  assert.match(dstMarkup, /2 days open/, "the rendered card must use local-calendar days across DST");

  const cases = [
    { days: 0, overdue: false, label: "0 days open" },
    { days: 1, overdue: true, label: "1 day open" },
    { days: 7, overdue: true, label: "7 days open" },
    { days: 14, overdue: true, label: "14 days open" },
  ];
  for (const { days, overdue, label } of cases) {
    const id = 100 + days;
    const { markup } = renderBoard([issue(id, "electrical", "high", days, "reported", overdue)]);
    const card = markup.match(new RegExp(`<button\\b[^>]*fix-track-board-card-${id}[\\s\\S]*?<\\/button>`))?.[0];
    assert.ok(card, `card ${id} should render`);
    assert.ok(card.includes(label), `card should display "${label}"`);
    assert.equal(card.includes(">Overdue</"), overdue, `overdue indicator should match the record at ${days} days`);
  }
});

test("selecting a board card invokes the edit action with that issue", () => {
  const selected: FixTrackBoardIssue[] = [];
  const target = issue(42, "electrical", "urgent", 1);
  const { tree } = renderBoard(
    [issue(43, "plumbing", "low", 4), target],
    fixedToday,
    selectedIssue => { selected.push(selectedIssue); },
  );
  const card = buttonsIn(tree).find(button => button.props["data-testid"] === "fix-track-board-card-42");
  assert.ok(card, "selectable issue card should render as a button");
  assert.equal(typeof card.props.onClick, "function");
  card.props.onClick?.({});
  assert.equal(selected.length, 1);
  assert.strictEqual(selected[0], target);
});