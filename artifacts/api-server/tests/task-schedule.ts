// Pure tests for staff-task occurrence rules (src/lib/taskSchedule.ts).
import assert from "node:assert/strict";
import { addDays, addMonthsToDay, isCalendarDay, occursOn, todayIn } from "../src/lib/taskSchedule";

const once = { recurrence: "once", startsOn: "2026-10-12" };
assert.equal(occursOn(once, "2026-10-12"), true);
assert.equal(occursOn(once, "2026-10-13"), false);
assert.equal(occursOn(once, "2026-10-11"), false);

const daily = { recurrence: "daily", startsOn: "2026-10-12" };
assert.equal(occursOn(daily, "2026-10-11"), false, "not before the start date");
assert.equal(occursOn(daily, "2026-10-12"), true);
assert.equal(occursOn(daily, "2027-03-01"), true);

const weekly = { recurrence: "weekly", startsOn: "2026-10-12" }; // a Monday
assert.equal(occursOn(weekly, "2026-10-19"), true);
assert.equal(occursOn(weekly, "2026-10-20"), false);
assert.equal(occursOn(weekly, "2026-10-05"), false, "not before the start date");
assert.equal(occursOn(weekly, "2027-03-29"), true, "same weekday across the clock change");

const monthly31 = { recurrence: "monthly", startsOn: "2026-01-31" };
assert.equal(occursOn(monthly31, "2026-02-28"), true, "clamped to the last day of February");
assert.equal(occursOn(monthly31, "2026-02-27"), false);
assert.equal(occursOn(monthly31, "2026-04-30"), true);
assert.equal(occursOn(monthly31, "2026-05-31"), true);
assert.equal(occursOn(monthly31, "2026-05-30"), false);
assert.equal(occursOn({ recurrence: "monthly", startsOn: "2028-01-29" }, "2028-02-29"), true, "leap day");
assert.equal(occursOn({ recurrence: "fortnightly", startsOn: "2026-10-12" }, "2026-10-12"), false, "unknown recurrence never occurs");

assert.equal(addDays("2026-03-01", -1), "2026-02-28");
assert.equal(addMonthsToDay("2026-01-31", 1), "2026-02-28");
assert.equal(addMonthsToDay("2026-01-15", 12), "2027-01-15");
assert.equal(addMonthsToDay("2026-06-10", 6), "2026-12-10");
assert.equal(isCalendarDay("2026-02-30"), false);
assert.equal(isCalendarDay("2026-02-28"), true);
assert.equal(isCalendarDay("28/02/2026"), false);

// 23:30 UTC on 12 Oct is already 13 Oct in London (BST).
assert.equal(todayIn("Europe/London", new Date("2026-10-12T23:30:00Z")), "2026-10-13");
assert.equal(todayIn("Not/AZone", new Date("2026-01-12T12:00:00Z")), "2026-01-12", "invalid zone falls back to London");

console.log("task-schedule: all assertions passed.");
