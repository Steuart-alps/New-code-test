import type { Contractor } from "@workspace/api-client-react";

// The hand-written contractor route returns these fields in addition to the
// older generated Contractor schema.
export type ContractorListRecord = Contractor & {
  gasSafeRegistration?: string | null;
  dbsExpiryDate?: string | null;
};

export type ContractorListStatus = {
  level: "complete" | "expiring" | "missing-or-expired";
  problems: string[];
};

function daysUntilExpiry(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  // DB timestamps and date inputs both begin with YYYY-MM-DD. Compare calendar
  // dates, not milliseconds, so an expiry remains valid through its last day.
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const expiry = Date.UTC(year, month - 1, day);
  if (new Date(expiry).toISOString().slice(0, 10) !== date) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((expiry - today) / 86_400_000);
}

export function getContractorListStatus(contractor: ContractorListRecord, now = new Date()): ContractorListStatus {
  const problems: string[] = [];
  let expiredOrMissing = false;
  let expiring = false;

  for (const [label, value] of [
    ["Public liability insurance", contractor.publicLiabilityExpiry],
    ["DBS / PVG check", contractor.dbsExpiryDate],
  ] as const) {
    const days = daysUntilExpiry(value, now);
    if (days === null) {
      problems.push(`${label}: missing expiry date`);
      expiredOrMissing = true;
    } else if (days < 0) {
      problems.push(`${label}: expired`);
      expiredOrMissing = true;
    } else if (days <= 30) {
      problems.push(`${label}: expiring ${days === 0 ? "today" : `in ${days} days`}`);
      expiring = true;
    }
  }

  if (!contractor.gasSafeRegistration?.trim()) {
    problems.push("Gas Safe registration: missing");
    expiredOrMissing = true;
  }

  return {
    level: expiredOrMissing ? "missing-or-expired" : expiring ? "expiring" : "complete",
    problems,
  };
}