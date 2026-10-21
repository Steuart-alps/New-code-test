// GreenTrack spraying book and stock: products, deliveries, stock counts,
// write-offs and application records whose products come off stock, the
// low-stock count on the status, and tenant isolation. Runs only through
// tests/run-fresh-schema.sh, which gives it a disposable database and API.
const BASE = process.env.API_BASE;
if (process.env.FRESH_SCHEMA_TEST !== "1" || !BASE) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/green-spraying.mjs (disposable database only)");
}
let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}: ${detail}`); console.error(`FAIL: ${name}: ${detail}`); }
}
const expectStatus = (name, response, expected) => check(name, expected.includes(response.status), `expected ${expected.join("/")}, got ${response.status} ${JSON.stringify(response.data)}`);
function session(defaultHeaders = {}) {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...defaultHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (response.headers.get("content-type") || "").includes("application/json") ? await response.json().catch(() => null) : null;
    return { status: response.status, data };
  };
}

async function registerTenant(label, stamp) {
  // Earlier dates need an override reason.
  const user = session({ "X-Override-Reason": encodeURIComponent("Spraying fixture: earlier records") });
  const email = `green-spray-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `Spray ${label}`, email, password: "password-123" });
  expectStatus(`register ${label}`, registered, [200, 201]);
  if (typeof registered.data?.verificationToken !== "string") throw new Error("Verification token unavailable; run via the test runner");
  expectStatus(`verify ${label}`, await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
  expectStatus(`login ${label}`, await user("POST", "/auth/login", { email, password: "password-123" }), [200]);
  return user;
}

const iso = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

async function main() {
  const stamp = Date.now();
  const owner = await registerTenant("owner", stamp);
  const other = await registerTenant("other", stamp);
  const stockOf = async (id) => (await owner("GET", "/green-track/products")).data?.find((p) => p.id === id)?.stockOnHand;

  // ── Products ───────────────────────────────────────────────────────────────
  expectStatus("a product needs a name", await owner("POST", "/green-track/products", { category: "pesticide" }), [400]);
  expectStatus("unknown product type refused", await owner("POST", "/green-track/products", { name: "X", category: "toString" }), [400]);
  expectStatus("unknown unit refused", await owner("POST", "/green-track/products", { name: "X", unit: "gallons" }), [400]);
  const fungicide = await owner("POST", "/green-track/products", {
    name: "Fungicide A", category: "pesticide", unit: "L", mappNumber: "12345", activeIngredient: "azoxystrobin", reorderLevel: 20,
  });
  expectStatus("add pesticide", fungicide, [201]);
  check("new product starts with no stock", fungicide.data?.stockOnHand === 0 && fungicide.data?.mappNumber === "12345", JSON.stringify(fungicide.data));
  const feed = await owner("POST", "/green-track/products", { name: "Spring feed 12-0-9", category: "fertiliser", unit: "kg" });
  expectStatus("add fertiliser", feed, [201]);
  const sand = await owner("POST", "/green-track/products", { name: "Rootzone sand", category: "top_dressing", unit: "t" });
  expectStatus("add top dressing", sand, [201]);
  const fId = fungicide.data.id; const feedId = feed.data.id; const sandId = sand.data.id;

  // ── Deliveries ─────────────────────────────────────────────────────────────
  expectStatus("a delivery needs a quantity above 0",
    await owner("POST", "/green-track/stock-movements", { productId: fId, movementDate: iso(-10), kind: "delivery", quantity: 0 }), [400]);
  expectStatus("unknown movement kind refused",
    await owner("POST", "/green-track/stock-movements", { productId: fId, movementDate: iso(-10), kind: "gift", quantity: 5 }), [400]);
  const delivery = await owner("POST", "/green-track/stock-movements", {
    productId: fId, movementDate: iso(-10), kind: "delivery", quantity: 100, supplier: "Agri Supplies", batchNumber: "B-77",
  });
  expectStatus("log delivery", delivery, [201]);
  check("delivery row", delivery.data?.quantity === 100 && delivery.data?.movementDate === iso(-10) && delivery.data?.productName === "Fungicide A", JSON.stringify(delivery.data));
  expectStatus("log feed delivery", await owner("POST", "/green-track/stock-movements", { productId: feedId, movementDate: iso(-10), kind: "delivery", quantity: 500 }), [201]);
  check("stock after delivery", await stockOf(fId) === 100);

  // ── Applications take product off stock ────────────────────────────────────
  const spray = {
    applicationDate: iso(-5), startTime: "06:30", endTime: "08:00", method: "spray",
    areas: ["greens"], areaDetails: "Greens 1-18", areaHectares: 1.2, waterVolumeLitres: 300,
    reason: "Fusarium patch", operatorName: "Sam Greenkeeper", operatorCertificate: "PA1 PA2 PA6 NPTC 123456",
    weather: "Dry, overcast", wind: "SW 4 mph", temperatureC: 9,
    products: [{ productId: fId, ratePerHectare: 1.5, quantityUsed: 1.8 }, { productId: feedId, quantityUsed: 25 }],
  };
  expectStatus("needs a product", await owner("POST", "/green-track/applications", { ...spray, products: [] }), [400]);
  expectStatus("needs where it was applied", await owner("POST", "/green-track/applications", { ...spray, areas: [], areaDetails: "" }), [400]);
  expectStatus("needs who applied it", await owner("POST", "/green-track/applications", { ...spray, operatorName: "" }), [400]);
  expectStatus("bad time refused", await owner("POST", "/green-track/applications", { ...spray, startTime: "25:00" }), [400]);
  expectStatus("unknown area refused", await owner("POST", "/green-track/applications", { ...spray, areas: ["car park"] }), [400]);
  expectStatus("a product listed twice is refused",
    await owner("POST", "/green-track/applications", { ...spray, products: [{ productId: fId, quantityUsed: 1 }, { productId: fId, quantityUsed: 2 }] }), [400]);
  expectStatus("a quantity is needed for each product",
    await owner("POST", "/green-track/applications", { ...spray, products: [{ productId: fId }] }), [400]);
  const applied = await owner("POST", "/green-track/applications", spray);
  expectStatus("record spraying", applied, [201]);
  check("record keeps its products", applied.data?.products?.length === 2
    && applied.data.products[0].productName === "Fungicide A" && applied.data.products[0].mappNumber === "12345"
    && applied.data.products[0].ratePerHectare === 1.5, JSON.stringify(applied.data?.products));
  check("record keeps the details", applied.data?.applicationDate === iso(-5) && applied.data?.startTime === "06:30"
    && applied.data?.areas?.[0] === "greens" && applied.data?.operatorCertificate === "PA1 PA2 PA6 NPTC 123456"
    && applied.data?.temperatureC === 9, JSON.stringify(applied.data));
  check("no warning while stock lasts", Array.isArray(applied.data?.stockWarnings) && applied.data.stockWarnings.length === 0, JSON.stringify(applied.data?.stockWarnings));
  check("pesticide comes off stock", await stockOf(fId) === 98.2, String(await stockOf(fId)));
  check("fertiliser comes off stock", await stockOf(feedId) === 475, String(await stockOf(feedId)));

  // ── A stock count sets the figure; later entries follow on from it ─────────
  expectStatus("a count needs the counted quantity",
    await owner("POST", "/green-track/stock-movements", { productId: fId, movementDate: iso(-2), kind: "count" }), [400]);
  const count = await owner("POST", "/green-track/stock-movements", { productId: fId, movementDate: iso(-2), kind: "count", countedQuantity: 90 });
  expectStatus("log stock count", count, [201]);
  check("stock follows the count", await stockOf(fId) === 90, String(await stockOf(fId)));
  const later = await owner("POST", "/green-track/applications", {
    applicationDate: iso(-1), method: "spray", areas: ["tees"], operatorName: "Sam Greenkeeper",
    products: [{ productId: fId, quantityUsed: 3 }],
  });
  expectStatus("record a later spraying", later, [201]);
  check("later spraying comes off the counted stock", await stockOf(fId) === 87, String(await stockOf(fId)));
  // Changing a record from before the count leaves the counted figure alone.
  expectStatus("correct the earlier record",
    await owner("PUT", `/green-track/applications/${applied.data.id}`, { products: [{ productId: fId, quantityUsed: 2.4 }, { productId: feedId, quantityUsed: 25 }] }), [200]);
  check("records before a count don't change stock", await stockOf(fId) === 87, String(await stockOf(fId)));
  const writeOff = await owner("POST", "/green-track/stock-movements", {
    productId: fId, movementDate: iso(0), kind: "write_off", quantity: 2, notes: "Container split",
  });
  expectStatus("write off spilt product", writeOff, [201]);
  check("write-off stored as negative", writeOff.data?.quantity === -2, JSON.stringify(writeOff.data));
  check("write-off comes off stock", await stockOf(fId) === 85, String(await stockOf(fId)));

  // Editing a later record changes stock; deleting it puts the product back.
  const edited = await owner("PUT", `/green-track/applications/${later.data.id}`, { products: [{ productId: fId, quantityUsed: 5 }] });
  expectStatus("edit later record", edited, [200]);
  check("edited quantity comes off stock", await stockOf(fId) === 83, String(await stockOf(fId)));
  check("edit keeps the other details", edited.data?.areas?.[0] === "tees" && edited.data?.operatorName === "Sam Greenkeeper", JSON.stringify(edited.data));
  expectStatus("delete later record", await owner("DELETE", `/green-track/applications/${later.data.id}`), [200]);
  check("deleting a record puts the product back", await stockOf(fId) === 88, String(await stockOf(fId)));

  // ── History, low stock and warnings ────────────────────────────────────────
  const history = await owner("GET", `/green-track/products/${fId}/history`);
  expectStatus("stock history", history, [200]);
  const kinds = history.data?.entries?.map((e) => `${e.kind}:${e.change}:${e.balance}`);
  check("history newest first with balances", JSON.stringify(kinds) === JSON.stringify([
    "write_off:-2:88", "count:-7.6:90", "application:-2.4:97.6", "delivery:100:100",
  ]), JSON.stringify(kinds));

  let products = (await owner("GET", "/green-track/products")).data;
  check("not low while above the re-order level", products.find((p) => p.id === fId)?.lowStock === false);
  const big = await owner("POST", "/green-track/applications", {
    applicationDate: iso(0), method: "spray", areas: ["fairways"], operatorName: "Sam Greenkeeper",
    products: [{ productId: fId, quantityUsed: 70 }, { productId: sandId, quantityUsed: 4 }],
  });
  expectStatus("record a big spraying", big, [201]);
  check("warns about a product with no stock left", big.data?.stockWarnings?.length === 1
    && big.data.stockWarnings[0].productName === "Rootzone sand" && big.data.stockWarnings[0].stockOnHand === -4, JSON.stringify(big.data?.stockWarnings));
  products = (await owner("GET", "/green-track/products")).data;
  check("low stock flagged at the re-order level", products.find((p) => p.id === fId)?.lowStock === true && products.find((p) => p.id === fId)?.stockOnHand === 18, JSON.stringify(products.find((p) => p.id === fId)));
  const status = await owner("GET", "/green-track/status");
  check("status counts low stock", status.data?.lowStockProducts === 1, JSON.stringify(status.data?.lowStockProducts));

  // ── Lists ──────────────────────────────────────────────────────────────────
  const all = await owner("GET", "/green-track/applications");
  check("spraying book lists records newest first", all.data?.length === 2 && all.data[0].id === big.data.id, JSON.stringify(all.data?.map((a) => a.id)));
  const bySand = await owner("GET", `/green-track/applications?productId=${sandId}`);
  check("filter by product", bySand.data?.length === 1 && bySand.data[0].id === big.data.id, JSON.stringify(bySand.data?.map((a) => a.id)));
  const ranged = await owner("GET", `/green-track/applications?from=${iso(-6)}&to=${iso(-4)}`);
  check("filter by dates", ranged.data?.length === 1 && ranged.data[0].id === applied.data.id, JSON.stringify(ranged.data?.map((a) => a.id)));
  const movements = await owner("GET", `/green-track/stock-movements?productId=${fId}`);
  check("stock records list", movements.data?.length === 3, JSON.stringify(movements.data?.map((m) => m.kind)));
  const correctedCount = await owner("PUT", `/green-track/stock-movements/${count.data.id}`, { countedQuantity: 91 });
  expectStatus("correct a stock count", correctedCount, [200]);
  check("corrected count is used", correctedCount.data?.countedQuantity === 91 && await stockOf(fId) === 19, String(await stockOf(fId)));

  // ── Products in use are archived, not deleted ──────────────────────────────
  const unitChange = await owner("PUT", `/green-track/products/${fId}`, { unit: "kg" });
  check("unit can't change once used", unitChange.status === 409 && unitChange.data?.code === "PRODUCT_UNIT_IN_USE", JSON.stringify(unitChange));
  const del = await owner("DELETE", `/green-track/products/${fId}`);
  check("a used product can't be deleted", del.status === 409 && del.data?.code === "PRODUCT_IN_USE", JSON.stringify(del));
  const archived = await owner("PUT", `/green-track/products/${fId}`, { active: false });
  check("archive a product", archived.status === 200 && archived.data?.active === false && archived.data?.name === "Fungicide A", JSON.stringify(archived.data));
  check("archived products are not counted as low", (await owner("GET", "/green-track/status")).data?.lowStockProducts === 0);
  const spare = await owner("POST", "/green-track/products", { name: "Never used", category: "seed", unit: "kg" });
  expectStatus("delete an unused product", await owner("DELETE", `/green-track/products/${spare.data.id}`), [200]);

  // ── A sprayer's QR label offers to record spraying ─────────────────────────
  const sprayer = await owner("POST", "/green-track/machines", { name: "Greens sprayer", type: "sprayer_spreader" });
  const mower = await owner("POST", "/green-track/machines", { name: "Greens mower", type: "pedestrian" });
  expectStatus("add sprayer", sprayer, [201]);
  expectStatus("add mower", mower, [201]);
  expectStatus("print labels", await owner("POST", "/equipment-labels/sheet", {
    items: [{ kind: "green_machine", ref: String(sprayer.data?.id) }, { kind: "green_machine", ref: String(mower.data?.id) }],
  }), [200, 201]);
  const labels = (await owner("GET", "/equipment-labels")).data ?? [];
  const sprayerLabel = labels.find?.((l) => l.kind === "green_machine" && l.name === "Greens sprayer");
  const mowerLabel = labels.find?.((l) => l.kind === "green_machine" && l.name === "Greens mower");
  check("labels listed", Boolean(sprayerLabel?.code && mowerLabel?.code), JSON.stringify(labels).slice(0, 400));
  if (sprayerLabel?.code && mowerLabel?.code) {
    const sprayerScan = await owner("GET", `/equipment-labels/scan/${sprayerLabel.code}`);
    check("sprayer scan offers to record spraying",
      sprayerScan.data?.actions?.some?.((a) => a.href === `/green-track?machine=${sprayer.data.id}&open=spraying`), JSON.stringify(sprayerScan.data?.actions));
    const mowerScan = await owner("GET", `/equipment-labels/scan/${mowerLabel.code}`);
    check("mower scan does not", !mowerScan.data?.actions?.some?.((a) => /open=spraying/.test(a.href)), JSON.stringify(mowerScan.data?.actions));
  }
  const withMachine = await owner("PUT", `/green-track/applications/${applied.data.id}`, { machineId: sprayer.data?.id });
  check("record the sprayer used", withMachine.status === 200 && withMachine.data?.machineName === "Greens sprayer", JSON.stringify(withMachine.data));

  // ── Tenant isolation ───────────────────────────────────────────────────────
  const otherList = await other("GET", "/green-track/products");
  check("other business sees no products", Array.isArray(otherList.data) && otherList.data.length === 0, JSON.stringify(otherList.data));
  check("other business sees no spraying records", (await other("GET", "/green-track/applications")).data?.length === 0);
  expectStatus("other business can't read the history", await other("GET", `/green-track/products/${feedId}/history`), [404]);
  expectStatus("other business can't edit a product", await other("PUT", `/green-track/products/${feedId}`, { name: "Hijack" }), [404]);
  expectStatus("other business can't log stock against it",
    await other("POST", "/green-track/stock-movements", { productId: feedId, movementDate: iso(0), kind: "delivery", quantity: 1 }), [404]);
  expectStatus("other business can't use the product in a record",
    await other("POST", "/green-track/applications", { applicationDate: iso(0), areas: ["greens"], operatorName: "X", products: [{ productId: feedId, quantityUsed: 1 }] }), [400]);
  expectStatus("other business can't edit a record", await other("PUT", `/green-track/applications/${applied.data.id}`, { reason: "x" }), [404]);
  expectStatus("other business can't name this business's sprayer",
    await other("POST", "/green-track/applications", { applicationDate: iso(0), areas: ["greens"], operatorName: "X", machineId: sprayer.data?.id, products: [{ productId: 999999, quantityUsed: 1 }] }), [400]);
  await other("DELETE", `/green-track/applications/${applied.data.id}`);
  await other("DELETE", `/green-track/stock-movements/${delivery.data.id}`);
  check("other business's deletes do nothing", (await owner("GET", "/green-track/applications")).data?.length === 2
    && (await owner("GET", `/green-track/stock-movements?productId=${fId}`)).data?.length === 3);

  console.log(`green spraying tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
