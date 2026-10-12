import assert from "node:assert/strict";
import { isCoveredByMinimumQuantity } from "../src/lib/siteChargeCoverage";

// A subscription started with no sites is billed for one site already.
const zeroSiteStart = { firstRowAfterSubscriptionId: 41, sitesBeforeSubscription: 0, rowsBeforeSubscription: 0 };
assert.equal(isCoveredByMinimumQuantity({ ...zeroSiteStart, rowId: 41 }), true, "first site after a 0-site checkout is covered");
assert.equal(isCoveredByMinimumQuantity({ ...zeroSiteStart, rowId: 42 }), false, "the second added site is charged");

// Sites that existed at checkout were counted in its quantity, so the first
// added site after it is a genuine extra and must be charged.
assert.equal(isCoveredByMinimumQuantity({ rowId: 41, firstRowAfterSubscriptionId: 41, sitesBeforeSubscription: 1, rowsBeforeSubscription: 0 }), false);
assert.equal(isCoveredByMinimumQuantity({ rowId: 41, firstRowAfterSubscriptionId: 41, sitesBeforeSubscription: 0, rowsBeforeSubscription: 1 }), false);
assert.equal(isCoveredByMinimumQuantity({ rowId: 41, firstRowAfterSubscriptionId: null, sitesBeforeSubscription: 0, rowsBeforeSubscription: 0 }), false);
console.log("billing minimum-quantity checks passed");
