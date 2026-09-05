import assert from "node:assert/strict";
import {
  buildSignupPath,
  parseSignupPlan,
  registrationPlanFields,
} from "../src/lib/signup-plan.ts";

const selectedSignupPath = buildSignupPath(["core", "fixtrack", "safetrack"], false);
assert.equal(selectedSignupPath, "/signup?modules=fixtrack%2Csafetrack");
const selectedQuery = new URL(selectedSignupPath, "https://example.test").search;
assert.deepEqual(parseSignupPlan(selectedQuery), {
  bundle: false,
  services: ["fixtrack", "safetrack"],
});
assert.deepEqual(registrationPlanFields(parseSignupPlan(selectedQuery)), {
  services: ["fixtrack", "safetrack"],
});

const bundleSignupPath = buildSignupPath(["core", "fixtrack", "safetrack"], true);
const bundleQuery = new URL(bundleSignupPath, "https://example.test").search;
assert.deepEqual(parseSignupPlan(bundleQuery), {
  bundle: true,
  services: ["fixtrack", "safetrack"],
});
assert.deepEqual(registrationPlanFields(parseSignupPlan(bundleQuery)), { bundle: true });

assert.deepEqual(
  parseSignupPlan(""),
  { bundle: false, services: [] },
);
assert.deepEqual(registrationPlanFields(parseSignupPlan("")), {});

assert.deepEqual(
  parseSignupPlan("?modules=safetrack,unknown,safetrack"),
  { bundle: false, services: ["safetrack"] },
);

assert.deepEqual(
  parseSignupPlan("?modules=doctrack,traintrack"),
  { bundle: false, services: ["doctrack", "traintrack"] },
);

console.log("Signup plan parsing tests passed.");