import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getNavGroups,
  isNavGroupInitiallyOpen,
  isNavItemPinnable,
  MAX_PINNED_NAV_ITEMS,
  navGroupStorageKey,
  parsePinnedHrefs,
  pinnedNavStorageKey,
  resolvePinnedNavItems,
  togglePinnedHref,
} from "../src/lib/nav-groups.ts";

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
assert.ok(!adminItems.includes("Business dashboard"), "Only platform operators see the business dashboard");
assert.ok(flattenGroups(getNavGroups({ isConsultant: true, canAdmin: true, isPlatformOperator: true })).includes("Business dashboard"),
  "Platform operators see the business dashboard");

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
assert.ok(userItems.includes("Asbestos Register"), "The core asbestos register is visible to every role");
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

// Audit and inspection reports are turned into actions by Owners, Managers and ALPS only.
assert.ok(adminItems.includes("Report actions") && managerItems.includes("Report actions"), "Managers and admins should see Report actions");
assert.ok(!userItems.includes("Report actions"), "Staff should not see Report actions");
assert.equal(guardedRoutes.get("/report-actions"), "canManageUsers", "App.tsx should register /report-actions for managers and admins");

assert.ok(userItems.includes("Calendar") && adminItems.includes("Calendar"), "Everyone should see the Calendar");

// Section membership: a nav edit that moves, drops or duplicates a link fails here.
const membership = groups => Object.fromEntries(groups.map(g => [g.id, g.items.map(i => i.href)]));
assert.deepEqual(membership(adminGroups), {
  core: ["/dashboard", "/portfolio"],
  setup: ["/settings", "/sites", "/users", "/staff-roster", "/equipment"],
  compliance: ["/external", "/contractors", "/calendar", "/compliance-hub"],
  safety: ["/fire-safety", "/legionella", "/safe-track", "/incidents", "/coshh-track", "/asbestos"],
  "food-water": ["/kitchen", "/allergens", "/aqua-track", "/hot-tub"],
  operations: ["/fix-track", "/premises-track", "/room-track", "/tree-track", "/bike-track", "/pat-track", "/pest-track", "/daily-track-am", "/daily-track-pm"],
  greenkeeping: ["/green-track"],
  "people-training": ["/doc-track", "/train-track"],
  reporting: ["/reports", "/report-actions"],
  other: ["/tasks"],
  admin: ["/categories", "/clients", "/feedback", "/privacy-governance"],
}, "Consultant admin sections");
assert.deepEqual(membership(userGroups), {
  core: ["/dashboard"],
  compliance: ["/external", "/contractors", "/calendar", "/compliance-hub"],
  safety: ["/fire-safety", "/legionella", "/safe-track", "/incidents", "/coshh-track", "/asbestos"],
  "food-water": ["/kitchen", "/allergens", "/aqua-track", "/hot-tub"],
  operations: ["/fix-track", "/premises-track", "/room-track", "/tree-track", "/bike-track", "/pat-track", "/pest-track", "/daily-track-am", "/daily-track-pm"],
  greenkeeping: ["/green-track"],
  "people-training": ["/doc-track", "/train-track"],
  reporting: ["/reports"],
  other: ["/tasks"],
}, "Staff and viewer sections (no empty Set up or Administration section)");
assert.deepEqual(membership(getNavGroups({ isConsultant: false, canAdmin: true })).admin,
  ["/categories", "/feedback", "/privacy-governance"], "Client admin Administration section");
assert.deepEqual(membership(getNavGroups({ isConsultant: false, canAdmin: false, canManageUsers: true })).setup,
  ["/users", "/equipment"], "Managers set up their own team and equipment");

// The menu follows the order a business sets up the service.
assert.deepEqual(adminGroups.map(g => g.id),
  ["core", "setup", "compliance", "safety", "food-water", "operations", "greenkeeping", "people-training", "reporting", "other", "admin"],
  "Sections run in setup order, with Other and Administration last");
const tasksItem = userGroups.flatMap(g => g.items).find(i => i.href === "/tasks");
assert.equal(tasksItem?.label, "Other reminders", "Tasks is shown as Other reminders");

for (const [label, groups] of [["consultant", adminGroups], ["staff", userGroups]]) {
  const all = hrefs(groups);
  assert.equal(new Set(all).size, all.length, `No link appears twice in the ${label} sidebar`);
  assert.ok(groups.every(g => g.items.length > 0), `No empty section in the ${label} sidebar`);
}

// Every link leads to a route App.tsx registers.
const routePaths = new Set([...appSource.matchAll(/<Route path="([^"]+)"/g)].map(m => m[1]));
for (const href of hrefs(adminGroups)) {
  assert.ok(routePaths.has(href), `Nav links to ${href}, but App.tsx has no route for it`);
}

// Every service key is one the API actually grants (ADDON_KEYS in api-server).
const servicesSource = readFileSync(new URL("../../api-server/src/lib/services.ts", import.meta.url), "utf8");
const addonKeys = new Set(JSON.parse(servicesSource.match(/export const ADDON_KEYS = (\[[^\]]*\])/)[1]));
assert.ok(addonKeys.has("firetrack") && addonKeys.size > 10, "Read ADDON_KEYS from api-server");
for (const item of adminGroups.flatMap(g => g.items)) {
  for (const key of item.serviceKeys ?? (item.serviceKey ? [item.serviceKey] : [])) {
    assert.ok(addonKeys.has(key), `${item.label} is gated on "${key}", which the API never grants`);
  }
}

// Which sections start open.
const groupById = id => userGroups.find(g => g.id === id);
const kitchenOnly = key => key === "kitchentrack";
const opensWith = (id, opts) => isNavGroupInitiallyOpen(groupById(id), { location: "/account-security", hasService: kitchenOnly, saved: null, ...opts });
assert.equal(opensWith("core"), true, "Home starts open");
assert.equal(opensWith("compliance"), true, "Compliance starts open");
assert.equal(opensWith("other"), false, "Other reminders starts tucked away");
assert.equal(opensWith("safety"), false, "Other sections start closed");
assert.equal(opensWith("core", { saved: "false" }), false, "A saved close is kept");
assert.equal(opensWith("safety", { saved: "true" }), true, "A saved open is kept");
assert.equal(opensWith("people-training", { saved: "true" }), false,
  "A section whose links are all locked stays closed, even if it was saved open");
assert.equal(opensWith("people-training", { saved: "true", hasService: () => true }), true,
  "It opens again once a module in it is unlocked");
assert.equal(opensWith("food-water", { location: "/kitchen", saved: "false" }), true, "The current page's section opens despite a saved close");
assert.equal(opensWith("food-water", { location: "/kitchen/extra", saved: "false" }), true, "Sub-pages count as the current page");
assert.equal(opensWith("people-training", { location: "/doc-track", saved: "false" }), true,
  "The current page's section opens even when its links are locked");
assert.equal(opensWith("food-water", { location: "/kitchenette", saved: "false" }), false, "A page that only shares a prefix doesn't count");

// Saved state is per user, per business and per section.
const keys = [navGroupStorageKey("7:1", "core"), navGroupStorageKey("7:2", "core"), navGroupStorageKey("8:1", "core"), navGroupStorageKey("7:1", "safety")];
assert.equal(new Set(keys).size, keys.length, "Section state keys differ by user, business and section");
assert.ok(!keys.includes(pinnedNavStorageKey("7:1")), "Pins and section state never share a key");

// Pinned links: per user and business, only links the user can open now.
assert.notEqual(pinnedNavStorageKey("7:1"), pinnedNavStorageKey("7:2"), "Pins are kept per business");
assert.notEqual(pinnedNavStorageKey("7:1"), pinnedNavStorageKey("8:1"), "Pins are kept per user");

const onlyFire = (key) => key === "firetrack";
const allItems = adminGroups.flatMap(g => g.items);
const fireItem = allItems.find(i => i.href === "/fire-safety");
const kitchenItem = allItems.find(i => i.href === "/kitchen");
assert.ok(isNavItemPinnable(fireItem, onlyFire), "An entitled module can be pinned");
assert.ok(!isNavItemPinnable(kitchenItem, onlyFire), "A locked module can't be pinned");
assert.ok(!isNavItemPinnable({ ...fireItem, comingSoon: true }, () => true), "A coming-soon link can't be pinned");
assert.ok(isNavItemPinnable(allItems.find(i => i.href === "/dashboard"), onlyFire), "Links without a service key can be pinned");

const resolved = resolvePinnedNavItems(["/kitchen", "/fire-safety", "/settings", "/no-such-page", "/dashboard"], userGroups, onlyFire);
assert.deepEqual(resolved.hrefs, ["/fire-safety", "/dashboard"],
  "Stale pins drop out: a module the business lost, an admin link the role no longer shows, and a removed page");
assert.deepEqual(resolved.items.map(i => i.label), ["FireTrack", "Dashboard"], "Pins keep their order");
assert.deepEqual(resolvePinnedNavItems(["/kitchen"], userGroups, () => true).hrefs, ["/kitchen"],
  "A pin survives while the business keeps the module");

assert.deepEqual(parsePinnedHrefs(null), []);
assert.deepEqual(parsePinnedHrefs("not json"), [], "A corrupt value is ignored");
assert.deepEqual(parsePinnedHrefs('{"href":"/x"}'), [], "Only a list is read");
assert.deepEqual(parsePinnedHrefs('["/a", 3, "/a", "javascript:alert(1)", "/b"]'), ["/a", "/b"],
  "Non-strings, duplicates and non-path values are dropped");
assert.equal(parsePinnedHrefs(JSON.stringify(["/1", "/2", "/3", "/4", "/5", "/6", "/7"])).length, MAX_PINNED_NAV_ITEMS);

assert.deepEqual(togglePinnedHref(["/a"], "/b"), ["/a", "/b"], "A new pin goes last");
assert.deepEqual(togglePinnedHref(["/a", "/b"], "/a"), ["/b"], "Pinning again unpins");
const full = Array.from({ length: MAX_PINNED_NAV_ITEMS }, (_, i) => `/${i}`);
assert.deepEqual(togglePinnedHref(full, "/extra"), full, "A full list refuses another pin");
assert.deepEqual(togglePinnedHref(full, "/0"), full.slice(1), "A full list can still unpin");

// The COSHH register is COSHHTrack's Substances tab, not a menu link of its own.
const allHrefs = userGroups.flatMap(g => g.items.map(i => i.href));
assert.ok(!allHrefs.includes("/coshh"), "No separate COSHH register link");
assert.ok(allHrefs.includes("/coshh-track"), "COSHHTrack is in the menu");

console.log("Nav groups visibility regression tests passed.");
