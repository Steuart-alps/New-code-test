// KitchenTrack allergen recipes: ingredients with contains / may contain,
// dishes worked out from their ingredients, an ingredient change pushed to
// every dish with a change log row, menus, chart sign-offs and "changed since
// last checked", importing suppliers' allergen information, plus tenant
// isolation, department scoping and viewers.
// Run: pnpm --filter @workspace/api-server run test:allergen-recipes
import assert from "node:assert/strict";
import { createTenant, createUser, pool } from "./approval-workflow-fixtures.mjs";

async function ok(promise, status, label) {
  const result = await promise;
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

const owner = await createTenant("allergen-recipes");
const foreign = await createTenant("allergen-recipes-foreign");
const kitchen = await ok(owner.request("POST", "/departments", { name: "Kitchen" }), 201, "department");
const lodges = await ok(owner.request("POST", "/departments", { name: "Lodges" }), 201, "second department");
const siteA = await ok(owner.request("POST", "/sites", { name: "Main restaurant", departmentId: kitchen.id }), 201, "site A");
const siteB = await ok(owner.request("POST", "/sites", { name: "Lodge cafe", departmentId: lodges.id }), 201, "site B");
const foreignSite = await ok(foreign.request("POST", "/sites", { name: "Foreign site" }), 201, "foreign site");
const viewer = await createUser(owner, { role: "client_viewer", departmentId: kitchen.id });
const staff = await createUser(owner, { role: "client_staff", departmentId: kitchen.id });

// ── Ingredients ──────────────────────────────────────────────────────────────
await ok(owner.request("POST", "/registers/allergen-ingredients", { siteId: null, name: "", contains: [] }), 400, "ingredient needs a name");
await ok(owner.request("POST", "/registers/allergen-ingredients", { siteId: null, name: "X", contains: ["kiwi"] }), 400, "unknown allergen");
await ok(owner.request("POST", "/registers/allergen-ingredients", { siteId: foreignSite.id, name: "X", contains: [] }), 400, "foreign site ingredient");
const bread = await ok(owner.request("POST", "/registers/allergen-ingredients", {
  siteId: null, name: "Sourdough loaf", supplier: "Town Bakery", contains: ["gluten", "gluten"], mayContain: ["sesame", "gluten"],
}), 201, "add bread");
assert.deepEqual(bread.contains, ["gluten"], "contains de-duplicated");
assert.deepEqual(bread.mayContain, ["sesame"], "may contain never repeats a contained allergen");
const butter = await ok(owner.request("POST", "/registers/allergen-ingredients", { siteId: null, name: "Butter", contains: ["milk"] }), 201, "add butter");
const mayo = await ok(owner.request("POST", "/registers/allergen-ingredients", { siteId: siteA.id, name: "Mayonnaise", contains: ["eggs", "mustard"] }), 201, "add site A mayo");
const lodgeJam = await ok(owner.request("POST", "/registers/allergen-ingredients", { siteId: siteB.id, name: "Lodge jam", contains: [] }), 201, "add site B jam");

// ── Dishes from ingredients ──────────────────────────────────────────────────
const sandwich = await ok(owner.request("POST", "/registers/allergens", {
  siteId: siteA.id, name: "Egg mayo sandwich", allergens: ["peanuts"],
  ingredients: [{ ingredientId: bread.id, quantity: 2, unit: "slice" }, { ingredientId: butter.id }, { ingredientId: mayo.id, quantity: 30, unit: "g" }],
}), 201, "dish from ingredients");
assert.deepEqual(sandwich.allergens, ["gluten", "eggs", "milk", "mustard"], "worked out from ingredients; hand ticks ignored");
assert.deepEqual(sandwich.mayContain, ["sesame"]);
assert.deepEqual(sandwich.ingredients.map((i) => [i.name, i.quantity, i.unit]), [["Sourdough loaf", 2, "slice"], ["Butter", null, null], ["Mayonnaise", 30, "g"]]);
await ok(owner.request("POST", "/registers/allergens", {
  siteId: siteA.id, name: "Bad", allergens: [], ingredients: [{ ingredientId: lodgeJam.id }],
}), 400, "ingredient from another site refused");
await ok(owner.request("POST", "/registers/allergens", {
  siteId: siteA.id, name: "Bad", allergens: [], ingredients: [{ ingredientId: bread.id }, { ingredientId: bread.id }],
}), 400, "an ingredient listed twice refused");
const toast = await ok(owner.request("POST", "/registers/allergens", {
  siteId: siteA.id, name: "Toast", allergens: [], ingredients: [{ ingredientId: bread.id }, { ingredientId: butter.id }],
}), 201, "second dish");
const handDish = await ok(owner.request("POST", "/registers/allergens", {
  siteId: siteA.id, name: "Bought-in cake", allergens: ["eggs", "milk"], mayContain: ["tree_nuts"],
}), 201, "hand-ticked dish");
assert.deepEqual(handDish.mayContain, ["tree_nuts"]);
assert.deepEqual(handDish.ingredients, []);
const lodgeDish = await ok(owner.request("POST", "/registers/allergens", {
  siteId: siteB.id, name: "Lodge scone", allergens: [], ingredients: [{ ingredientId: bread.id }, { ingredientId: lodgeJam.id }],
}), 201, "site B dish");

// Old clients that send no mayContain or recipe keep both.
const kept = await ok(owner.request("PUT", `/registers/allergens/${handDish.id}`, {
  siteId: siteA.id, name: "Bought-in cake", allergens: ["eggs", "milk"],
}), 200, "edit without mayContain");
assert.deepEqual(kept.mayContain, ["tree_nuts"], "may contain kept");
const keptRecipe = await ok(owner.request("PUT", `/registers/allergens/${toast.id}`, { siteId: siteA.id, name: "Hot toast", allergens: [] }), 200, "rename keeps recipe");
assert.equal(keptRecipe.ingredients.length, 2);
assert.deepEqual(keptRecipe.allergens, ["gluten", "milk"]);

// A recipe change that changes the allergens needs a reason.
await ok(owner.request("PUT", `/registers/allergens/${toast.id}`, {
  siteId: siteA.id, name: "Hot toast", allergens: [], ingredients: [{ ingredientId: bread.id }, { ingredientId: butter.id }, { ingredientId: mayo.id }],
}), 400, "recipe change without a reason");
assert.equal((await pool.query("SELECT count(*)::int AS n FROM allergen_item_ingredients WHERE item_id = $1", [toast.id])).rows[0].n, 2, "refused change rolled back");
await ok(owner.request("PUT", `/registers/allergens/${toast.id}`, {
  siteId: siteA.id, name: "Hot toast", allergens: [], ingredients: [{ ingredientId: bread.id }],
  changeReason: "Served dry",
}), 200, "recipe change with a reason");
// Moving a dish to a site its recipe's ingredients can't be used at.
await ok(owner.request("PUT", `/registers/allergens/${sandwich.id}`, { siteId: siteB.id, name: "Egg mayo sandwich", allergens: [] }), 400, "site move with site-only ingredient");

// ── Menus ────────────────────────────────────────────────────────────────────
const lunch = await ok(owner.request("POST", "/registers/allergen-menus", { siteId: siteA.id, name: "Lunch" }), 201, "add menu");
const lodgeMenu = await ok(owner.request("POST", "/registers/allergen-menus", { siteId: siteB.id, name: "Cafe" }), 201, "add site B menu");
await ok(owner.request("POST", "/registers/allergen-menus", { siteId: foreignSite.id, name: "X" }), 400, "foreign site menu");
const onLunch = await ok(owner.request("PUT", `/registers/allergens/${sandwich.id}`, {
  siteId: siteA.id, name: "Egg mayo sandwich", allergens: [], menuIds: [lunch.id],
}), 200, "put dish on menu");
assert.deepEqual(onLunch.menuIds, [lunch.id]);
await ok(owner.request("PUT", `/registers/allergens/${toast.id}`, {
  siteId: siteA.id, name: "Hot toast", allergens: [], menuIds: [lodgeMenu.id],
}), 400, "menu at another site refused");

// ── Charts and sign-offs ─────────────────────────────────────────────────────
let charts = await ok(owner.request("GET", "/registers/allergen-charts"), 200, "charts");
const chart = (siteId, menuId = null) => charts.find((c) => c.siteId === siteId && c.menuId === menuId);
assert.equal(chart(siteA.id).dishCount, 3, "site A chart has three dishes");
assert.equal(chart(siteA.id, lunch.id).dishCount, 1, "lunch chart has one dish");
assert.equal(chart(siteA.id).lastSignoff, null, "not signed off yet");
await ok(owner.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteA.id, confirmed: false }), 400, "sign-off needs confirmation");
await ok(owner.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteA.id, menuId: lodgeMenu.id, confirmed: true }), 400, "menu from another site");
const emptyMenu = await ok(owner.request("POST", "/registers/allergen-menus", { siteId: siteA.id, name: "Brunch" }), 201, "empty menu");
await ok(owner.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteA.id, menuId: emptyMenu.id, confirmed: true }), 400, "empty chart can't be signed off");
const signed = await ok(owner.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteA.id, confirmed: true, note: "Checked with head chef" }), 201, "sign off site chart");
assert.equal(signed.dishCount, 3);
assert.ok(signed.checkedByName, "signed by the signed-in person");
await ok(owner.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteA.id, menuId: lunch.id, confirmed: true }), 201, "sign off lunch chart");
charts = await ok(owner.request("GET", "/registers/allergen-charts"), 200, "charts after sign-off");
assert.equal(chart(siteA.id).changedSinceCheck, false);
assert.equal(chart(siteA.id).lastSignoff.note, "Checked with head chef");
assert.equal(chart(siteA.id, lunch.id).changedSinceCheck, false);

// A reviewed-date-only edit does not need a new sign-off.
await new Promise((resolve) => setTimeout(resolve, 20));
await ok(owner.request("PUT", `/registers/allergens/${handDish.id}`, {
  siteId: siteA.id, name: "Bought-in cake", allergens: ["eggs", "milk"], lastReviewedAt: "2026-10-01",
}), 200, "review date edit");
charts = await ok(owner.request("GET", "/registers/allergen-charts"), 200, "charts after review edit");
assert.equal(chart(siteA.id).changedSinceCheck, false, "review date is not a chart change");

// ── An ingredient change is pushed to every dish ─────────────────────────────
await ok(owner.request("PUT", `/registers/allergen-ingredients/${bread.id}`, {
  siteId: null, name: "Sourdough loaf", supplier: "New Bakery", contains: ["gluten", "sesame"], mayContain: [],
}), 400, "ingredient allergen change without a reason");
const swapped = await ok(owner.request("PUT", `/registers/allergen-ingredients/${bread.id}`, {
  siteId: null, name: "Sourdough loaf", supplier: "New Bakery", contains: ["gluten", "sesame"], mayContain: [],
  changeReason: "New supplier; loaf has a sesame crust",
}), 200, "supplier swap");
assert.equal(swapped.dishesUpdated, 3, "sandwich, toast and the lodge scone updated");
assert.deepEqual(swapped.usedIn.map((d) => d.name).sort(), ["Egg mayo sandwich", "Hot toast", "Lodge scone"]);
const dishes = await ok(owner.request("GET", "/registers/allergens"), 200, "dishes after swap");
const after = dishes.find((d) => d.id === sandwich.id);
assert.deepEqual(after.allergens, ["gluten", "eggs", "milk", "mustard", "sesame"]);
assert.deepEqual(after.mayContain, [], "sesame now contained, no longer a trace");
const sandwichLog = await ok(owner.request("GET", `/registers/allergens/${sandwich.id}/changes`), 200, "dish change log");
assert.equal(sandwichLog[0].changeType, "allergens_changed");
assert.match(sandwichLog[0].reason, /Sourdough loaf.*sesame crust/);
assert.deepEqual(sandwichLog[0].mayContainBefore, ["sesame"]);
const breadLog = await ok(owner.request("GET", `/registers/allergen-ingredients/${bread.id}/changes`), 200, "ingredient change log");
assert.deepEqual(breadLog.map((c) => c.changeType), ["allergens_changed", "created"]);
assert.equal(breadLog[0].dishesUpdated, 3);
charts = await ok(owner.request("GET", "/registers/allergen-charts"), 200, "charts after ingredient change");
assert.equal(chart(siteA.id).changedSinceCheck, true, "site chart needs checking again");
assert.equal(chart(siteA.id, lunch.id).changedSinceCheck, true, "lunch chart needs checking again");
await ok(owner.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteA.id, confirmed: true }), 201, "sign off again");
charts = await ok(owner.request("GET", "/registers/allergen-charts"), 200, "charts after second sign-off");
assert.equal(chart(siteA.id).changedSinceCheck, false);
const history = await ok(owner.request("GET", `/registers/allergen-charts/signoffs?siteId=${siteA.id}`), 200, "sign-off history");
assert.equal(history.length, 2, "every sign-off kept");
assert.equal((await ok(owner.request("GET", `/registers/allergen-charts/signoffs?siteId=${siteA.id}&menuId=${lunch.id}`), 200, "menu history")).length, 1);

// Removing a dish marks its charts.
await ok(owner.request("DELETE", `/registers/allergens/${sandwich.id}`), 204, "remove dish");
charts = await ok(owner.request("GET", "/registers/allergen-charts"), 200, "charts after removal");
assert.equal(chart(siteA.id).changedSinceCheck, true, "removal marks the site chart");
assert.equal(chart(siteA.id, lunch.id).dishCount, 0);

// ── Removing and moving ingredients ──────────────────────────────────────────
await ok(owner.request("DELETE", `/registers/allergen-ingredients/${bread.id}`), 409, "ingredient in a recipe can't be removed");
await ok(owner.request("PUT", `/registers/allergen-ingredients/${bread.id}`, {
  siteId: siteA.id, name: "Sourdough loaf", contains: ["gluten", "sesame"],
}), 400, "can't limit to one site while another site's dish uses it");
await ok(owner.request("DELETE", `/registers/allergen-ingredients/${mayo.id}`), 204, "unused ingredient removed (its only dish was removed)");
assert.ok((await pool.query("SELECT deleted_at FROM allergen_ingredients WHERE id = $1", [mayo.id])).rows[0]?.deleted_at, "soft-deleted");
assert.equal((await ok(owner.request("GET", `/registers/allergen-ingredients/${mayo.id}/changes`), 200, "log after removal"))[0].changeType, "removed");

// ── Staff, viewers and other businesses ──────────────────────────────────────
const staffIngredients = await ok(staff.request("GET", "/registers/allergen-ingredients"), 200, "staff ingredients");
assert.ok(staffIngredients.some((i) => i.id === bread.id), "staff see every-site ingredients");
assert.ok(!staffIngredients.some((i) => i.id === lodgeJam.id), "staff don't see another department's site ingredients");
assert.ok(!staffIngredients.find((i) => i.id === bread.id).usedIn.some((d) => d.id === lodgeDish.id), "usage hides other departments' dishes");
await ok(staff.request("PUT", `/registers/allergen-ingredients/${butter.id}`, {
  siteId: siteB.id, name: "Butter", contains: ["milk"],
}), 400, "scoped staff cannot move an ingredient to another department's site");
await ok(staff.request("PUT", `/registers/allergen-ingredients/${lodgeJam.id}`, { siteId: null, name: "x", contains: [] }), 404, "staff edit other department ingredient");
const staffCharts = await ok(staff.request("GET", "/registers/allergen-charts"), 200, "staff charts");
assert.ok(staffCharts.every((c) => c.siteId === siteA.id), "staff see their own site's charts only");
await ok(staff.request("GET", `/registers/allergen-charts/signoffs?siteId=${siteB.id}`), 404, "staff other department history");
await ok(staff.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteB.id, confirmed: true }), 400, "staff sign off other department");
await ok(staff.request("DELETE", `/registers/allergen-menus/${lodgeMenu.id}`), 404, "staff delete other department menu");

await ok(viewer.request("GET", "/registers/allergen-ingredients"), 403, "viewer ingredients");
await ok(viewer.request("POST", "/registers/allergen-ingredients", { siteId: null, name: "V", contains: [] }), 403, "viewer add ingredient");
await ok(viewer.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteA.id, confirmed: true }), 403, "viewer sign-off");
await ok(viewer.request("POST", "/registers/allergen-menus", { siteId: siteA.id, name: "V" }), 403, "viewer add menu");

assert.equal((await ok(foreign.request("GET", "/registers/allergen-ingredients"), 200, "foreign ingredients")).length, 0);
assert.equal((await ok(foreign.request("GET", "/registers/allergen-menus"), 200, "foreign menus")).length, 0);
assert.equal((await ok(foreign.request("GET", "/registers/allergen-charts"), 200, "foreign charts")).length, 0);
await ok(foreign.request("PUT", `/registers/allergen-ingredients/${butter.id}`, { siteId: null, name: "x", contains: [] }), 404, "foreign edit ingredient");
await ok(foreign.request("DELETE", `/registers/allergen-ingredients/${butter.id}`), 404, "foreign delete ingredient");
await ok(foreign.request("GET", `/registers/allergen-ingredients/${butter.id}/changes`), 404, "foreign ingredient log");
await ok(foreign.request("PUT", `/registers/allergen-menus/${lunch.id}`, { name: "x" }), 404, "foreign rename menu");
await ok(foreign.request("GET", `/registers/allergen-charts/signoffs?siteId=${siteA.id}`), 404, "foreign sign-off history");
await ok(foreign.request("POST", "/registers/allergen-charts/signoffs", { siteId: siteA.id, confirmed: true }), 400, "foreign sign-off");
await ok(foreign.request("POST", "/registers/allergens", {
  siteId: foreignSite.id, name: "Stolen", allergens: [], ingredients: [{ ingredientId: butter.id }],
}), 400, "foreign ingredient in a recipe");
await ok(foreign.request("PUT", `/registers/allergens/${lodgeDish.id}`, { siteId: foreignSite.id, name: "x", allergens: [], menuIds: [lunch.id] }), 404, "foreign dish edit");

// Menu rename marks its chart; removal hides it.
await ok(owner.request("PUT", `/registers/allergen-menus/${lunch.id}`, { name: "Lunch menu" }), 200, "rename menu");
await ok(owner.request("DELETE", `/registers/allergen-menus/${emptyMenu.id}`), 204, "remove menu");
charts = await ok(owner.request("GET", "/registers/allergen-charts"), 200, "charts after menu removal");
assert.ok(!chart(siteA.id, emptyMenu.id), "removed menu has no chart");
assert.equal(chart(siteA.id, lunch.id).menuName, "Lunch menu");

// ── Import suppliers' allergen information (POST /imports/allergen-ingredients) ──
{
  const cream = await ok(owner.request("POST", "/registers/allergen-ingredients", { siteId: siteA.id, name: "Double cream", contains: ["milk"] }), 201, "add cream");
  const trifle = await ok(owner.request("POST", "/registers/allergens", {
    siteId: siteA.id, name: "Trifle", allergens: [], ingredients: [{ ingredientId: cream.id }],
  }), 201, "dish using the cream");
  const headers = ["Product description", "Supplier", "Code", "Milk", "Cereals containing gluten", "Soya", "Site"];
  const file = {
    headers,
    rows: [
      ["Strong flour", "Town Mill", "SF1", "N", "Y", "May", ""],
      ["double cream", "Dairy Co", "DC9", "Yes", "N", "Traces", "Main restaurant"],
    ],
  };
  const bad = { headers, rows: [...file.rows, ["Mystery", "", "", "?", "", "", ""]] };
  const preview = await ok(owner.request("POST", "/imports/allergen-ingredients", { ...bad, preview: true }), 200, "preview with an error row");
  assert.deepEqual(preview.summary, { total: 3, create: 1, update: 1, skip: 0, error: 1 });
  assert.match(preview.rows[1].reasons.join(" "), /may contain Soya/, "the preview says what changes");
  await ok(owner.request("POST", "/imports/allergen-ingredients", { ...bad, preview: false }), 409, "nothing imported while a row has an error");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM allergen_ingredients WHERE name = 'Strong flour'")).rows[0].n, 0, "refused import wrote nothing");
  await ok(owner.request("POST", "/imports/allergen-ingredients", { headers: ["Ingredient", "Supplier"], rows: [["Flour", "Mill"]] }), 400, "a file without allergen columns");

  await ok(staff.request("POST", "/imports/allergen-ingredients", file), 403, "staff cannot bulk import");
  await ok(viewer.request("POST", "/imports/allergen-ingredients", file), 403, "viewer cannot import");
  const foreignTry = await ok(foreign.request("POST", "/imports/allergen-ingredients", { ...file, rows: [file.rows[1]], preview: false }), 409, "another business's import");
  assert.match(foreignTry.rows[0].reasons.join(" "), /Site "Main restaurant" was not found/, "another business's site name is not found");

  const done = await ok(owner.request("POST", "/imports/allergen-ingredients", { ...file, preview: false }), 200, "import");
  assert.equal(done.committed, true);
  const ingredients = await ok(owner.request("GET", "/registers/allergen-ingredients"), 200, "ingredients after import");
  const flour = ingredients.find((i) => i.name === "Strong flour");
  assert.equal(flour.siteId, null, "a blank Site is every site");
  assert.deepEqual([flour.contains, flour.mayContain, flour.supplier, flour.productCode], [["gluten"], ["soya"], "Town Mill", "SF1"]);
  assert.ok(flour.lastCheckedAt && flour.checkedBy, "recorded as checked by the person importing");
  const updatedCream = ingredients.find((i) => i.id === cream.id);
  assert.deepEqual([updatedCream.contains, updatedCream.mayContain, updatedCream.supplier], [["milk"], ["soya"], "Dairy Co"]);
  const dishes = await ok(owner.request("GET", "/registers/allergens"), 200, "dishes after import");
  assert.deepEqual(dishes.find((d) => d.id === trifle.id).mayContain, ["soya"], "dishes using the ingredient are updated");
  const log = await ok(owner.request("GET", `/registers/allergen-ingredients/${cream.id}/changes`), 200, "cream change log");
  assert.equal(log[0].changeType, "allergens_changed");
  assert.equal(log[0].reason, "Supplier allergen information imported");
  assert.equal(log[0].dishesUpdated, 1);

  const again = await ok(owner.request("POST", "/imports/allergen-ingredients", { ...file, preview: true }), 200, "the same file again");
  assert.deepEqual(again.summary, { total: 2, create: 0, update: 0, skip: 2, error: 0 }, "an unchanged file changes nothing");
}

await pool.end();
console.log("Allergen recipes: ingredients, recipes, menus and chart sign-offs passed.");
