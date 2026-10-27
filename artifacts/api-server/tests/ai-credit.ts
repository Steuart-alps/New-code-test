// Pure tests for the AI allowance ledger (src/lib/aiCredit.ts): unused
// allowance carries over, the oldest is used first, and whatever is left 12
// months after the end of its month lapses (Steuart, 2026-10-27).
import assert from "node:assert/strict";
import { addMonthsUtc, replayAiCredit, type AiCreditLot } from "../src/lib/aiCredit";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
/** One month's £10, usable from the 1st and lapsing 12 months after the month ends. */
const month = (iso: string, pence = 1000): AiCreditLot => {
  const startsAt = day(iso);
  return { startsAt, expiresAt: addMonthsUtc(addMonthsUtc(startsAt, 1), 12), pence };
};

// Month arithmetic keeps the day within shorter months.
assert.equal(addMonthsUtc(day("2027-01-31"), 1).toISOString(), "2027-02-28T00:00:00.000Z");
assert.equal(addMonthsUtc(day("2027-03-31"), -1).toISOString(), "2027-02-28T00:00:00.000Z");
assert.equal(addMonthsUtc(day("2026-11-01"), 12).toISOString(), "2027-11-01T00:00:00.000Z");

// Nothing used: everything carries over.
const twoMonths = [month("2026-11-01"), month("2026-12-01")];
assert.equal(replayAiCredit(twoMonths, [], day("2026-12-15")).balancePence, 2000);

// The oldest is used first.
const used = replayAiCredit(twoMonths, [{ at: day("2026-12-10"), pence: 1200 }], day("2026-12-15"));
assert.equal(used.balancePence, 800);
assert.deepEqual(used.open.map((lot) => lot.remainingPence), [800], "November's £10 went first, then £2 of December's");

// Use can only come from allowance that existed then: December's £10 can't pay for November's use.
const early = replayAiCredit(twoMonths, [{ at: day("2026-11-20"), pence: 1000 }], day("2026-12-15"));
assert.deepEqual(early.open.map((lot) => lot.remainingPence), [1000]);

// Steuart's example: £10 a month for 12 months is £120; £50 used; once each
// month's leftover lapses, nothing is left and £70 has gone back to ALPS.
const year = Array.from({ length: 12 }, (_, i) => month(addMonthsUtc(day("2026-11-01"), i).toISOString().slice(0, 10)));
const fiftyPounds = Array.from({ length: 5 }, (_, i) => ({ at: addMonthsUtc(day("2026-11-05"), i * 2), pence: 1000 }));
const stillOpen = replayAiCredit(year, fiftyPounds, day("2027-10-31"));
assert.equal(stillOpen.balancePence, 7000, "£70 unused at the end of the year, still usable");
const afterLapse = replayAiCredit(year, fiftyPounds, day("2028-11-01"));
assert.equal(afterLapse.balancePence, 0, "all lapsed 12 months after the last month ended");

// A month's leftover lapses 12 months after that month ends, and not before.
const november = [month("2026-11-01")];
assert.equal(replayAiCredit(november, [], day("2027-11-30")).balancePence, 1000);
assert.equal(replayAiCredit(november, [], day("2027-12-01")).balancePence, 0);

// A top-up is used along with its month's allowance and lapses with it.
const withTopUp = [...november, { startsAt: day("2026-11-20"), expiresAt: november[0].expiresAt, pence: 400 }];
assert.equal(replayAiCredit(withTopUp, [{ at: day("2026-11-25"), pence: 1200 }], day("2026-12-15")).balancePence, 200);

// Going past what was left is owed and taken from the next allowance, never forgiven.
const over = replayAiCredit(twoMonths, [{ at: day("2026-11-25"), pence: 1030 }], day("2026-11-28"));
assert.equal(over.balancePence, -30);
assert.equal(replayAiCredit(twoMonths, [{ at: day("2026-11-25"), pence: 1030 }], day("2026-12-02")).balancePence, 970);

console.log("AI credit ledger: all checks passed");
