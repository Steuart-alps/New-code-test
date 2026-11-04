// The ALPS 50% discount covers ComplyTrack and its tracks only (Steuart,
// 2026-10-27: "discount is tracks only"): the AI add-on and extra storage stay
// full price. The coupon is limited to the track products with applies_to,
// its id follows the product list (coupons can't be edited), and it is never
// made without products, which Stripe would apply to the whole subscription.
// The database and Stripe are stubbed; nothing external is contacted.
//   node tests/alps-discount-coupon.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-alps-discount-coupon-"));
const outFile = path.join(outDir, "alps-discount.mjs");

// The stub database answers with globalThis.__alpsDiscountDb.rows and keeps the queries.
const dbState = { rows: [], queries: [] };
globalThis.__alpsDiscountDb = dbState;
const dbStub = `
  export const db = {
    async execute(query) {
      globalThis.__alpsDiscountDb.queries.push(query);
      return { rows: globalThis.__alpsDiscountDb.rows };
    },
  };
`;

let discount;
try {
  await build({
    entryPoints: [path.join(testsDir, "../src/lib/alpsDiscount.ts")],
    outfile: outFile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{
      name: "db-stub",
      setup(builder) {
        builder.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db-stub", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: dbStub, loader: "js" }));
      },
    }],
  });
  discount = await import(pathToFileURL(outFile).href);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

function fakeStripe(existing = new Map()) {
  const created = [];
  return {
    created,
    coupons: {
      async retrieve(id) {
        if (!existing.has(id)) throw Object.assign(new Error("No such coupon"), { code: "resource_missing" });
        return existing.get(id);
      },
      async create(params, options) {
        created.push({ params, options });
        const coupon = { id: params.id, percent_off: params.percent_off, duration: params.duration, applies_to: params.applies_to };
        existing.set(params.id, coupon);
        return coupon;
      },
    },
  };
}

// Track products come from the synced prices, leaving out AI and storage.
dbState.rows = [{ product: "prod_core" }, { product: "prod_fire" }, { product: "prod_bundle" }];
const products = await discount.listAlpsDiscountProductIds();
assert.deepEqual(products, ["prod_core", "prod_fire", "prod_bundle"]);
const listQuery = dbState.queries.at(-1);
const listSql = JSON.stringify(listQuery);
assert.match(listSql, /NOT IN \('storage', /, "storage prices are left out");
assert.ok(listSql.includes('"ai"'), "AI add-on prices are left out");

// A new coupon is limited to exactly those products, 50% off forever.
const stripe = fakeStripe();
const id = await discount.getAlpsDiscountCouponId(stripe, ["prod_fire", "prod_core", "prod_bundle", "prod_core"]);
assert.match(id, /^complytrack_alps50_tracks_[0-9a-f]{16}$/);
assert.equal(stripe.created.length, 1);
assert.deepEqual(stripe.created[0].params.applies_to, { products: ["prod_bundle", "prod_core", "prod_fire"] });
assert.equal(stripe.created[0].params.percent_off, 50);
assert.equal(stripe.created[0].params.duration, "forever");
assert.equal(stripe.created[0].options.idempotencyKey, `create-${id}`);

// The same products reuse it; the order they arrive in doesn't matter.
assert.equal(await discount.getAlpsDiscountCouponId(stripe, ["prod_core", "prod_bundle", "prod_fire"]), id);
assert.equal(stripe.created.length, 1, "an existing coupon is reused");

// A new track product means a new coupon for later redemptions.
const next = await discount.getAlpsDiscountCouponId(stripe, ["prod_core", "prod_bundle", "prod_fire", "prod_tree"]);
assert.notEqual(next, id);
assert.deepEqual(stripe.created[1].params.applies_to.products, ["prod_bundle", "prod_core", "prod_fire", "prod_tree"]);

// Read from the database when no list is given.
dbState.rows = [{ product: "prod_core" }];
const fromDb = await discount.getAlpsDiscountCouponId(fakeStripe());
assert.match(fromDb, /^complytrack_alps50_tracks_/);

// Never a coupon with no products: Stripe would discount everything.
dbState.rows = [];
const empty = fakeStripe();
await assert.rejects(discount.getAlpsDiscountCouponId(empty), /No ComplyTrack track products/);
assert.equal(empty.created.length, 0);

// A coupon with that id but other settings is refused, not used.
const wrong = new Map([[id, { id, percent_off: 50, duration: "forever", applies_to: { products: ["prod_core"] } }]]);
await assert.rejects(discount.getAlpsDiscountCouponId(fakeStripe(wrong), ["prod_core", "prod_bundle", "prod_fire"]), /not configured/);

console.log("ALPS discount coupon checks passed: tracks only, never the AI add-on or storage.");
