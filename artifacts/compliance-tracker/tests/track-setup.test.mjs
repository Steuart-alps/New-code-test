import assert from "node:assert/strict";
import { planTrackSetup, describeItems } from "../src/lib/track-setup.ts";

// Setting tracks up from a setup workbook (src/lib/track-setup.ts): named
// lists become each track's items; Counts per site become numbered items; a
// track's own list wins over the counts for the same site.
{
  const plan = planTrackSetup([
    { name: "Counts per site", headers: ["Track", "Item", "Clubhouse", "Lodges", "Notes"], rows: [
      ["KitchenTrack", "Fridges", "10", "", ""],
      ["KitchenTrack", "Freezers", "5", "0", ""],
      ["TubTrack", "Hot tubs", "", "4", ""],
      ["LegionellaTrack", "Showers", "2", "", ""],
      ["FireTrack", "Fire alarm call points", "12", "3", ""],
      ["BikeTrack", "Hire bikes", "", "", ""],
      ["Every business", "Staff (approximate)", "40", "", ""],
      ["KitchenTrack", "Display fridges or chillers", "lots", "", ""],
    ] },
  ]);
  const group = (kind, site) => plan.groups.find((g) => g.kind === kind && g.siteName === site);
  const fridges = group("cold-units", "Clubhouse");
  assert.equal(fridges.items.length, 15, "10 fridges and 5 freezers at the clubhouse");
  assert.deepEqual(fridges.items.slice(0, 2), [{ name: "Fridge 1", type: "fridge" }, { name: "Fridge 2", type: "fridge" }]);
  assert.deepEqual(fridges.items.at(-1), { name: "Freezer 5", type: "freezer" });
  assert.equal(group("cold-units", "Lodges"), undefined, "0 freezers adds nothing");
  assert.deepEqual(group("hot-tubs", "Lodges").items.map((i) => i.name), ["Hot tub 1", "Hot tub 2", "Hot tub 3", "Hot tub 4"]);
  assert.deepEqual(group("outlets", "Clubhouse").items, [{ name: "Shower 1", type: "little_used" }, { name: "Shower 2", type: "little_used" }]);
  assert.equal(group("call-points", "Clubhouse").items.length, 12);
  assert.equal(group("call-points", "Lodges").items[2].name, "CP3");
  assert.ok(!plan.groups.some((g) => g.kind === "bikes"), "a blank count adds nothing");
  assert.ok(plan.skipped.some((line) => line.includes("lots")), "a count that isn't a number is reported");
  assert.equal(describeItems(fridges.items), "Fridge 1, Fridge 2, Fridge 3 … Freezer 5 (15)");
}
{
  const plan = planTrackSetup([
    { name: "Read me", headers: ["x"], rows: [] },
    { name: "Fridges and freezers", headers: ["Name", "Type (fridge or freezer)", "Site", "Location"], rows: [
      ["Walk-in fridge", "Fridge", "Clubhouse", "Kitchen"],
      ["Chest freezer", "Freezer", "Clubhouse", ""],
      ["Bain marie", "Hot hold", "Clubhouse", ""],
      ["Bar fridge", "", "", ""],
    ] },
    { name: "Counts per site", headers: ["Track", "Item", "Clubhouse", "Halfway house", "Notes"], rows: [
      ["KitchenTrack", "Fridges", "10", "2", ""],
    ] },
    { name: "Outlets", headers: ["Outlet name", "Type (hot, cold, calorifier, TMV, little-used)", "Location", "Site"], rows: [
      ["Room 12 basin hot", "Hot", "First floor", "Clubhouse"],
      ["Boiler room", "Calorifier", "", "Clubhouse"],
      ["Mystery tap", "Warm", "", "Clubhouse"],
    ] },
    { name: "Bikes", headers: ["Reference", "Name", "Type (road, mountain, hybrid, e-bike, kids, cargo, other)", "Site"], rows: [["B01", "Blue Raleigh", "E-bike", ""]] },
  ]);
  const clubhouse = plan.groups.filter((g) => g.kind === "cold-units" && g.siteName === "Clubhouse");
  assert.equal(clubhouse.length, 1, "the named list wins over the clubhouse count");
  assert.deepEqual(clubhouse[0].items.map((i) => `${i.name}:${i.type}`), ["Walk-in fridge:fridge", "Chest freezer:freezer"]);
  assert.equal(plan.groups.find((g) => g.kind === "cold-units" && g.siteName === "Halfway house").items.length, 2, "the counts still set up a site with no named list");
  assert.deepEqual(plan.groups.find((g) => g.kind === "cold-units" && g.siteName === null).items, [{ name: "Bar fridge", type: "fridge" }], "a blank site is the whole business");
  assert.ok(plan.skipped.some((line) => line.startsWith("Bain marie")), "hot holding units are left out");
  assert.deepEqual(plan.groups.find((g) => g.kind === "outlets").items.map((i) => i.type), ["hot", "calorifier"]);
  assert.ok(plan.skipped.some((line) => line.startsWith("Mystery tap")));
  assert.deepEqual(plan.groups.find((g) => g.kind === "bikes").items, [{ name: "B01", description: "Blue Raleigh", type: "ebike" }]);
}
console.log("Track setup from workbooks: counts, named lists and what is left out all check out.");
