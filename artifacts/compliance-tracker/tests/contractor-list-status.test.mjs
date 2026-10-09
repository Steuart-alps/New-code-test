import assert from "node:assert/strict";
import { getContractorListStatus } from "../src/lib/contractor-list-status.ts";

const today = new Date(2026, 8, 25, 12);
const record = {
  name: "Test contractor",
  publicLiabilityExpiry: "2026-11-25T00:00:00.000Z",
  dbsExpiryDate: "2026-12-01T00:00:00.000Z",
  gasSafeRegistration: "GS-123",
};

assert.deepEqual(getContractorListStatus(record, today), { level: "complete", problems: [] });

const warning = getContractorListStatus({
  ...record,
  publicLiabilityExpiry: "2026-10-25T00:00:00.000Z",
}, today);
assert.equal(warning.level, "expiring");
assert.match(warning.problems[0], /30 days/);
assert.equal(getContractorListStatus({ ...record, publicLiabilityExpiry: "2026-10-26" }, today).level, "complete");

const expired = getContractorListStatus({
  ...record,
  publicLiabilityExpiry: "2026-09-24",
  dbsExpiryDate: "2026-09-25T00:00:00.000Z",
}, today);
assert.equal(expired.level, "missing-or-expired");
assert.match(expired.problems.join(" "), /insurance: expired/);
assert.match(expired.problems.join(" "), /DBS \/ PVG check: expiring today/);

const missing = getContractorListStatus({
  ...record,
  publicLiabilityExpiry: null,
  dbsExpiryDate: null,
  gasSafeRegistration: " ",
}, today);
assert.equal(missing.level, "missing-or-expired");
assert.equal(missing.problems.length, 3);
assert.equal(getContractorListStatus({ ...record, dbsExpiryDate: "invalid" }, today).level, "missing-or-expired");

console.log("Contractor list compliance status tests passed.");