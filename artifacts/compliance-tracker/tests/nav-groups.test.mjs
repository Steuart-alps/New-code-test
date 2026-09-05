import assert from "node:assert/strict";
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

// Non-admin user
const userGroups = getNavGroups({ isConsultant: false, canAdmin: false });
const userItems = flattenGroups(userGroups);
assert.ok(!userItems.includes("Settings"), "User should not see Settings");
assert.ok(!userItems.includes("Clients"), "User should not see Clients");
assert.ok(!userItems.includes("Users"), "User should not see Users");
assert.ok(!userItems.includes("Staff Roster"), "User should not see Staff Roster");
assert.ok(!userItems.includes("Sites"), "User should not see Sites");
assert.ok(userItems.includes("FireTrack"), "User should see FireTrack");

console.log("Nav groups visibility regression tests passed.");
