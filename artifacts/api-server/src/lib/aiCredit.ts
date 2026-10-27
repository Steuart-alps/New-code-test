// The AI allowance ledger, replayed (lib/aiAllowance.ts reads the rows and
// keeps the rules about who gets what). Kept free of the database so it can be
// tested on its own (tests/ai-credit.ts).

/** The same day and time `months` later (or earlier), kept within shorter months. */
export function addMonthsUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

/** Some AI use to spend: a month's allowance or a top-up, usable from startsAt until expiresAt. */
export interface AiCreditLot { startsAt: Date; expiresAt: Date; pence: number }
/** One request to Claude, at its cost (or its estimate while pending). */
export interface AiCreditUse { at: Date; pence: number }
export interface AiCreditBalance {
  /** Unused AI use now, in pence; below zero when the last request went past what was left. */
  balancePence: number;
  /** What is left of each lot still usable now, soonest to lapse first. */
  open: Array<AiCreditLot & { remainingPence: number }>;
}

/**
 * Replay the ledger: each request takes from the lot that lapses soonest (the
 * oldest) among those usable when it was made. A request may start while any
 * allowance is left, so one can go past it; what it went over is taken from
 * the next allowance or top-up, never forgiven. Whatever a lot still holds
 * when it lapses is lost.
 */
export function replayAiCredit(lots: AiCreditLot[], uses: AiCreditUse[], now: Date): AiCreditBalance {
  const ordered = lots
    .map((lot) => ({ ...lot, remainingPence: lot.pence }))
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.startsAt.getTime() - b.startsAt.getTime());
  let owed = 0;
  const take = (at: Date) => {
    for (const lot of ordered) {
      if (owed <= 0) break;
      if (lot.remainingPence <= 0 || lot.startsAt > at || lot.expiresAt <= at) continue;
      const taken = Math.min(lot.remainingPence, owed);
      // Ignore float dust (a millionth of a penny) so a lot that is spent reads as empty.
      lot.remainingPence = lot.remainingPence - taken < 1e-6 ? 0 : lot.remainingPence - taken;
      owed = owed - taken < 1e-6 ? 0 : owed - taken;
    }
  };
  for (const use of [...uses].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    owed += use.pence;
    take(use.at);
  }
  take(now);
  const open = ordered.filter((lot) => lot.startsAt <= now && lot.expiresAt > now && lot.remainingPence > 0);
  const left = open.reduce((sum, lot) => sum + lot.remainingPence, 0);
  return { balancePence: owed > 0 ? -owed : left, open };
}
