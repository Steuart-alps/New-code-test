import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getNavGroups } from "../src/lib/nav-groups.ts";

function flattenGroups(groups) {
  return groups.flatMap(g => g.items.map(i => i.label));
}

// Consultant and Admin
const adminGroups = getNavGroups({ isConsultant: true, canAdmin: true });
const adminItems = flattenGroups(adminGroups);
assert.ok(adminItems.includes("Settings"), "Admin should see Settings");
assert.ok(adminItems.includes("Clients"), "Consultant should see Clients");
assert.ok(adminItems.includes("Users"), "Admin should see Users");
assert.ok(adminItems.includes("Staff Roster"), "Admin should see Staff Roster");
assert.ok(adminItems.includes("Sites"), "Admin should see Sites");
assert.ok(adminItems.includes("Feedback inbox"), "Admin should see the feedback inbox");
assert.ok(adminItems.includes("Categories"), "Admin should see Categories");

// Non-admin user
const userGroups = getNavGroups({ isConsultant: false, canAdmin: false });
const userItems = flattenGroups(userGroups);
assert.ok(!userItems.includes("Settings"), "User should not see Settings");
assert.ok(!userItems.includes("Clients"), "User should not see Clients");
assert.ok(!userItems.includes("Users"), "User should not see Users");
assert.ok(!userItems.includes("Staff Roster"), "User should not see Staff Roster");
assert.ok(!userItems.includes("Sites"), "User should not see Sites");
assert.ok(!userItems.includes("Feedback inbox"), "Staff and viewers should not see internal feedback");
assert.ok(!userItems.includes("Categories"), "Staff and viewers should not see the admin-only Categories page");
assert.ok(userItems.includes("FireTrack"), "User should see FireTrack");
assert.ok(userItems.includes("COSHH Register") && userItems.includes("Asbestos Register"), "Core registers are visible to every role");
const allergens = userGroups.flatMap(g => g.items).find(i => i.label === "Allergens");
assert.equal(allergens?.serviceKey, "kitchentrack", "Allergen records sit under the KitchenTrack entitlement");

// Every nav link must lead to a route the role can open: App.tsx registers
// some routes only for admins or consultants, and a link to one is a 404.
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const guardedRoutes = new Map();
for (const match of appSource.matchAll(/\{(\w+) && <Route path="([^"]+)"/g)) {
  guardedRoutes.set(match[2], match[1]);
}
assert.ok(guardedRoutes.get("/categories") === "canAdmin", "App.tsx should still register /categories for admins only");
const hrefs = (groups) => groups.flatMap(g => g.items.map(i => i.href));
for (const href of hrefs(userGroups)) {
  assert.ok(!guardedRoutes.has(href), `Non-admin nav links to ${href}, which App.tsx only registers when ${guardedRoutes.get(href)}`);
}
const clientAdminHrefs = hrefs(getNavGroups({ isConsultant: false, canAdmin: true }));
for (const href of clientAdminHrefs) {
  const guard = guardedRoutes.get(href);
  assert.ok(guard === undefined || guard === "canAdmin" || guard === "canManageUsers" || guard === "canManageContractorEmails",
    `Client admin nav links to ${href}, which App.tsx only registers when ${guard}`);
}

// Equipment and its QR labels are kept by managers and admins only.
const managerItems = flattenGroups(getNavGroups({ isConsultant: false, canAdmin: false, canManageUsers: true }));
assert.ok(adminItems.includes("Equipment & QR labels") && managerItems.includes("Equipment & QR labels"), "Managers and admins should see Equipment & QR labels");
assert.ok(!userItems.includes("Equipment & QR labels"), "Staff should not see the equipment list");
assert.equal(guardedRoutes.get("/equipment"), "canManageUsers", "App.tsx should register /equipment for managers and admins");

assert.ok(userItems.includes("Calendar") && adminItems.includes("Calendar"), "Everyone should see the Calendar");

console.log("Nav groups visibility regression tests passed.");
