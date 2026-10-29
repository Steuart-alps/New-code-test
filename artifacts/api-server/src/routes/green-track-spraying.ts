import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getClientId, requireClientAdmin, denyViewers } from "../middleware/requireAuth";
import { resolveStaffPerformer, resolveStaffPerformerUpdate } from "../lib/staffPerformer";
import { todayIn } from "../lib/taskSchedule";
import {
  GREEN_APPLICATION_AREAS, GREEN_APPLICATION_METHODS, GREEN_PRODUCT_CATEGORIES, GREEN_PRODUCT_UNITS,
  GREEN_STOCK_MOVEMENT_KINDS, greenStockLedger, parseQuantity, stockOnHand,
} from "../lib/greenStock";

/**
 * GreenTrack spraying book and stock: products, deliveries, stock counts,
 * write-offs and application records (spraying, spreading, top dressing).
 * Applying a product takes it off stock. Mounted under /green-track.
 */
const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PRODUCTS_PER_APPLICATION = 20;

type Body = Record<string, unknown>;

function rows<T = any>(result: any): T[] {
  return result.rows as T[];
}

function camel(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), value]),
  );
}

/** Trimmed text up to `max` characters; "" becomes null, undefined stays undefined. */
function text(value: unknown, max = 500): string | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (trimmed.length > max) return "invalid";
  return trimmed || null;
}

class InputError extends Error {}

function textField(body: Body, key: string, label: string, max = 500) {
  const value = text(body[key], max);
  if (value === "invalid") throw new InputError(`${label} must be text of up to ${max} characters`);
  return value;
}

function quantityField(body: Body, key: string, label: string) {
  const value = parseQuantity(body[key]);
  if (value === "invalid") throw new InputError(`${label} must be a number of 0 or more`);
  return value;
}

function sendError(res: any, err: unknown, fallback: string) {
  if (err instanceof InputError) return res.status(400).json({ error: err.message });
  return res.status(500).json({ error: fallback });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

const PRODUCT_COLUMNS = sql`
  p.id, p.name, p.category, p.unit, p.mapp_number, p.active_ingredient, p.supplier,
  p.reorder_level, p.notes, p.active, p.created_at, p.updated_at
`;

async function productsWithStock(clientId: number, where = sql``) {
  const products = rows(await db.execute(sql`
    SELECT ${PRODUCT_COLUMNS} FROM green_products p WHERE p.client_id = ${clientId} ${where}
    ORDER BY p.active DESC, lower(p.name), p.id
  `));
  const ledger = await greenStockLedger(clientId);
  const stock = stockOnHand(ledger);
  const lastDelivery = new Map<number, string>();
  const lastCount = new Map<number, string>();
  for (const entry of ledger) {
    if (entry.kind === "delivery") lastDelivery.set(entry.productId, entry.date);
    if (entry.kind === "count") lastCount.set(entry.productId, entry.date);
  }
  return products.map((p: any) => {
    const onHand = stock.get(p.id) ?? 0;
    const reorderLevel = p.reorder_level == null ? null : Number(p.reorder_level);
    return {
      ...camel(p),
      id: p.id as number,
      reorderLevel,
      stockOnHand: onHand,
      lowStock: p.active && reorderLevel != null && onHand <= reorderLevel,
      lastDeliveryDate: lastDelivery.get(p.id) ?? null,
      lastCountDate: lastCount.get(p.id) ?? null,
    };
  });
}

function productInput(body: Body, creating: boolean) {
  const out: Record<string, unknown> = {};
  const name = textField(body, "name", "Name", 200);
  if (creating && !name) throw new InputError("Product name is required");
  if (name !== undefined) {
    if (!name) throw new InputError("Product name is required");
    out.name = name;
  }
  if (body.category !== undefined) {
    if (!GREEN_PRODUCT_CATEGORIES.includes(body.category as any)) throw new InputError("Unknown product type");
    out.category = body.category;
  }
  if (body.unit !== undefined) {
    if (!GREEN_PRODUCT_UNITS.includes(body.unit as any)) throw new InputError("Unknown unit");
    out.unit = body.unit;
  }
  for (const [key, column, label, max] of [
    ["mappNumber", "mapp_number", "MAPP number", 40],
    ["activeIngredient", "active_ingredient", "Active ingredient", 300],
    ["supplier", "supplier", "Supplier", 200],
    ["notes", "notes", "Notes", 2000],
  ] as const) {
    const value = textField(body, key, label, max);
    if (value !== undefined) out[column] = value;
  }
  const reorder = quantityField(body, "reorderLevel", "Re-order level");
  if (reorder !== undefined) out.reorder_level = reorder;
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw new InputError("active must be true or false");
    out.active = body.active;
  }
  return out;
}

router.get("/products", async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    res.json(await productsWithStock(clientId));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

router.post("/products", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const input = productInput(req.body ?? {}, true);
    // What is on the shelf already, saved as today's stock count so use can
    // come off it straight away.
    const openingStock = quantityField(req.body ?? {}, "openingStock", "Amount in stock now");
    const inserted = await db.transaction(async (tx) => {
      const product = rows(await tx.execute(sql`
        INSERT INTO green_products (client_id, name, category, unit, mapp_number, active_ingredient, supplier, reorder_level, notes, active, created_by)
        VALUES (${clientId}, ${input.name}, ${input.category ?? "other"}, ${input.unit ?? "L"}, ${input.mapp_number ?? null},
                ${input.active_ingredient ?? null}, ${input.supplier ?? null}, ${input.reorder_level ?? null}, ${input.notes ?? null},
                ${input.active ?? true}, ${req.currentUser!.id})
        RETURNING id
      `))[0];
      if (openingStock != null) {
        await tx.execute(sql`
          INSERT INTO green_stock_movements (client_id, product_id, movement_date, kind, quantity, counted_quantity, notes, created_by)
          VALUES (${clientId}, ${product.id}, ${todayIn()}, 'count', 0, ${openingStock}, 'Stock when the product was added', ${req.currentUser!.id})
        `);
      }
      return product;
    });
    const [product] = await productsWithStock(clientId, sql`AND p.id = ${inserted.id}`);
    res.status(201).json(product);
  } catch (err) {
    sendError(res, err, "Failed to create product");
  }
});

router.put("/products/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const existing = rows(await db.execute(sql`
      SELECT id, unit FROM green_products WHERE id = ${req.params.id} AND client_id = ${clientId}
    `))[0];
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const input = productInput(req.body ?? {}, false);
    if (input.unit !== undefined && input.unit !== existing.unit) {
      const used = rows(await db.execute(sql`
        SELECT 1 FROM green_stock_movements WHERE client_id = ${clientId} AND product_id = ${existing.id}
        UNION ALL
        SELECT 1 FROM green_application_products WHERE client_id = ${clientId} AND product_id = ${existing.id}
        LIMIT 1
      `)).length > 0;
      if (used) {
        return res.status(409).json({
          error: `This product already has stock records in ${existing.unit}. Add a new product for a different unit.`,
          code: "PRODUCT_UNIT_IN_USE",
        });
      }
    }
    const value = (column: string) => input[column] === undefined ? sql.raw(`"${column}"`) : sql`${input[column]}`;
    await db.execute(sql`
      UPDATE green_products
         SET name = ${value("name")}, category = ${value("category")}, unit = ${value("unit")},
             mapp_number = ${value("mapp_number")}, active_ingredient = ${value("active_ingredient")},
             supplier = ${value("supplier")}, reorder_level = ${value("reorder_level")}, notes = ${value("notes")},
             active = ${value("active")}, updated_at = now()
       WHERE id = ${existing.id} AND client_id = ${clientId}
    `);
    const [product] = await productsWithStock(clientId, sql`AND p.id = ${existing.id}`);
    res.json(product);
  } catch (err) {
    sendError(res, err, "Failed to update product");
  }
});

// A product with any stock or application records is archived, not deleted,
// so the spraying book keeps what was applied.
router.delete("/products/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const existing = rows(await db.execute(sql`SELECT id FROM green_products WHERE id = ${req.params.id} AND client_id = ${clientId}`))[0];
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const used = rows(await db.execute(sql`
      SELECT 1 FROM green_stock_movements WHERE client_id = ${clientId} AND product_id = ${existing.id}
      UNION ALL
      SELECT 1 FROM green_application_products WHERE client_id = ${clientId} AND product_id = ${existing.id}
      LIMIT 1
    `)).length > 0;
    if (used) {
      return res.status(409).json({
        error: "This product has stock or spraying records, so it can't be deleted. Archive it instead.",
        code: "PRODUCT_IN_USE",
      });
    }
    await db.execute(sql`DELETE FROM green_products WHERE id = ${existing.id} AND client_id = ${clientId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// A product's stock history, newest first, with the balance after each entry.
router.get("/products/:id/history", async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const [product] = await productsWithStock(clientId, sql`AND p.id = ${Number(req.params.id) || 0}`);
    if (!product) return res.status(404).json({ error: "Product not found" });
    const ledger = await greenStockLedger(clientId, product.id);
    res.json({ product, entries: ledger.reverse() });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stock history" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STOCK MOVEMENTS — deliveries, stock counts, write-offs
// ═══════════════════════════════════════════════════════════════════════════════

const MOVEMENT_SELECT = sql`
  SELECT m.id, m.product_id, p.name AS product_name, p.unit, to_char(m.movement_date, 'YYYY-MM-DD') AS movement_date,
         m.kind, m.quantity, m.counted_quantity, m.supplier, m.batch_number, m.reference,
         m.recorded_by, m.recorded_by_roster_id, m.notes, m.created_at, m.updated_at
    FROM green_stock_movements m
    JOIN green_products p ON p.id = m.product_id AND p.client_id = m.client_id
`;

async function movementById(clientId: number, id: number) {
  const row = rows(await db.execute(sql`${MOVEMENT_SELECT} WHERE m.client_id = ${clientId} AND m.id = ${id}`))[0];
  return row ? camel(row) : null;
}

/** Signed stored quantity and counted figure for a movement of `kind`. */
function movementAmounts(kind: string, body: Body) {
  if (kind === "count") {
    const counted = quantityField(body, "countedQuantity", "Counted quantity");
    if (counted == null) throw new InputError("Enter the quantity counted");
    return { quantity: 0, counted };
  }
  const quantity = quantityField(body, "quantity", "Quantity");
  if (quantity == null || quantity <= 0) throw new InputError("Enter a quantity above 0");
  return { quantity: kind === "write_off" || kind === "use" ? -quantity : quantity, counted: null };
}

router.get("/stock-movements", async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const { productId, limit } = req.query as Record<string, string | undefined>;
    const max = Math.min(Math.max(parseInt(limit ?? "200", 10) || 200, 1), 1000);
    const result = await db.execute(sql`
      ${MOVEMENT_SELECT}
      WHERE m.client_id = ${clientId} ${productId && /^\d+$/.test(productId) ? sql`AND m.product_id = ${productId}` : sql``}
      ORDER BY m.movement_date DESC, m.created_at DESC, m.id DESC
      LIMIT ${max}
    `);
    res.json(rows(result).map(camel));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stock records" });
  }
});

router.post("/stock-movements", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const body: Body = req.body ?? {};
    const product = rows(await db.execute(sql`
      SELECT id, category FROM green_products WHERE id = ${Number(body.productId) || 0} AND client_id = ${clientId}
    `))[0];
    if (!product) return res.status(404).json({ error: "Product not found" });
    if (typeof body.movementDate !== "string" || !ISO_DATE.test(body.movementDate)) {
      return res.status(400).json({ error: "movementDate must be a date (YYYY-MM-DD)" });
    }
    const kind = body.kind;
    if (!GREEN_STOCK_MOVEMENT_KINDS.includes(kind as any)) return res.status(400).json({ error: "kind must be delivery, count, write_off or use" });
    // A pesticide's use belongs in the spraying book, the legal record.
    if (kind === "use" && product.category === "pesticide") {
      return res.status(400).json({ error: "Record pesticide use as a spraying record", code: "PESTICIDE_USE_NEEDS_SPRAYING_RECORD" });
    }
    const { quantity, counted } = movementAmounts(kind as string, body);
    const supplier = textField(body, "supplier", "Supplier", 200);
    const batchNumber = textField(body, "batchNumber", "Batch number", 100);
    const reference = textField(body, "reference", "Reference", 200);
    const notes = textField(body, "notes", "Notes", 2000);
    const recordedByName = textField(body, "recordedBy", "Recorded by", 200);
    const rosterId = body.recordedByRosterId == null ? null : Number(body.recordedByRosterId);
    const performer = await resolveStaffPerformer(clientId, rosterId, recordedByName ?? null);
    if (rosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const inserted = rows(await db.execute(sql`
      INSERT INTO green_stock_movements (
        client_id, product_id, movement_date, kind, quantity, counted_quantity, supplier, batch_number, reference,
        recorded_by, recorded_by_roster_id, notes, created_by
      ) VALUES (
        ${clientId}, ${product.id}, ${body.movementDate}, ${kind}, ${quantity}, ${counted}, ${supplier ?? null},
        ${batchNumber ?? null}, ${reference ?? null}, ${performer?.performedBy ?? null}, ${performer?.staffRosterId ?? null},
        ${notes ?? null}, ${req.currentUser!.id}
      )
      RETURNING id
    `))[0];
    res.status(201).json(await movementById(clientId, inserted.id));
  } catch (err) {
    sendError(res, err, "Failed to save stock record");
  }
});

// The product and kind stay as recorded; delete and re-add to change them.
router.put("/stock-movements/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const body: Body = req.body ?? {};
    const existing = rows(await db.execute(sql`
      SELECT * FROM green_stock_movements WHERE id = ${req.params.id} AND client_id = ${clientId}
    `))[0] as any;
    if (!existing) return res.status(404).json({ error: "Stock record not found" });
    if (body.movementDate !== undefined && (typeof body.movementDate !== "string" || !ISO_DATE.test(body.movementDate))) {
      return res.status(400).json({ error: "movementDate must be a date (YYYY-MM-DD)" });
    }
    const amountsSent = existing.kind === "count" ? body.countedQuantity !== undefined : body.quantity !== undefined;
    const amounts = amountsSent ? movementAmounts(existing.kind, body) : null;
    const supplier = textField(body, "supplier", "Supplier", 200);
    const batchNumber = textField(body, "batchNumber", "Batch number", 100);
    const reference = textField(body, "reference", "Reference", 200);
    const notes = textField(body, "notes", "Notes", 2000);
    const recordedByName = textField(body, "recordedBy", "Recorded by", 200);
    const rosterId = body.recordedByRosterId === undefined ? undefined : body.recordedByRosterId === null ? null : Number(body.recordedByRosterId);
    const performer = await resolveStaffPerformerUpdate(
      clientId, rosterId, recordedByName, existing.recorded_by_roster_id, existing.recorded_by,
    );
    if (rosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const keep = <T,>(input: T | undefined, stored: T) => (input === undefined ? stored : input);
    await db.execute(sql`
      UPDATE green_stock_movements
         SET movement_date = ${keep(body.movementDate as string | undefined, existing.movement_date)},
             quantity = ${amounts ? amounts.quantity : existing.quantity},
             counted_quantity = ${amounts ? amounts.counted : existing.counted_quantity},
             supplier = ${keep(supplier, existing.supplier)}, batch_number = ${keep(batchNumber, existing.batch_number)},
             reference = ${keep(reference, existing.reference)}, notes = ${keep(notes, existing.notes)},
             recorded_by = ${performer?.performedBy ?? null}, recorded_by_roster_id = ${performer?.staffRosterId ?? null},
             updated_at = now()
       WHERE id = ${existing.id} AND client_id = ${clientId}
    `);
    res.json(await movementById(clientId, existing.id));
  } catch (err) {
    sendError(res, err, "Failed to update stock record");
  }
});

router.delete("/stock-movements/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`DELETE FROM green_stock_movements WHERE id = ${req.params.id} AND client_id = ${clientId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete stock record" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// APPLICATIONS — the spraying book (also spreading and top dressing)
// ═══════════════════════════════════════════════════════════════════════════════

interface ApplicationProductInput { productId: number; ratePerHectare: number | null; quantityUsed: number }

async function applicationsWhere(clientId: number, where = sql``, limit = 200) {
  const applications = rows(await db.execute(sql`
    SELECT a.id, to_char(a.application_date, 'YYYY-MM-DD') AS application_date, a.start_time, a.end_time, a.method,
           a.machine_id, m.name AS machine_name, a.areas, a.area_details, a.area_hectares, a.water_volume_litres,
           a.nozzle, a.reason, a.operator_name, a.operator_roster_id, a.operator_certificate,
           a.weather, a.wind, a.temperature_c, a.notes, a.created_at, a.updated_at
      FROM green_applications a
      LEFT JOIN green_machines m ON m.id = a.machine_id AND m.client_id = a.client_id
     WHERE a.client_id = ${clientId} ${where}
     ORDER BY a.application_date DESC, a.start_time DESC NULLS LAST, a.id DESC
     LIMIT ${limit}
  `));
  if (!applications.length) return [];
  const ids = applications.map((a: any) => a.id as number);
  const products = rows(await db.execute(sql`
    SELECT ap.application_id, ap.product_id, p.name AS product_name, p.category, p.unit, p.mapp_number,
           ap.rate_per_hectare, ap.quantity_used
      FROM green_application_products ap
      JOIN green_products p ON p.id = ap.product_id AND p.client_id = ap.client_id
     WHERE ap.client_id = ${clientId} AND ap.application_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
     ORDER BY ap.id
  `));
  return applications.map((a: any) => ({
    ...camel(a),
    products: products.filter((p: any) => p.application_id === a.id).map((p: any) => {
      const { applicationId: _ignored, ...rest } = camel(p);
      return rest;
    }),
  }));
}

/** Validates an application body; `existing` is the stored row when editing. */
async function applicationInput(clientId: number, body: Body, existing: any | null) {
  const out: Record<string, unknown> = {};
  if (body.applicationDate !== undefined || !existing) {
    if (typeof body.applicationDate !== "string" || !ISO_DATE.test(body.applicationDate)) {
      throw new InputError("applicationDate must be a date (YYYY-MM-DD)");
    }
    out.application_date = body.applicationDate;
  }
  for (const key of ["startTime", "endTime"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && value !== "" && (typeof value !== "string" || !TIME.test(value))) {
      throw new InputError(`${key === "startTime" ? "Start" : "Finish"} time must be HH:MM`);
    }
    out[key === "startTime" ? "start_time" : "end_time"] = value || null;
  }
  if (body.method !== undefined) {
    if (!GREEN_APPLICATION_METHODS.includes(body.method as any)) throw new InputError("Unknown application method");
    out.method = body.method;
  }
  if (body.machineId !== undefined) {
    if (body.machineId === null || body.machineId === "") out.machine_id = null;
    else {
      const machine = rows(await db.execute(sql`
        SELECT id FROM green_machines WHERE id = ${Number(body.machineId) || 0} AND client_id = ${clientId}
      `))[0];
      if (!machine) throw new InputError("Machine not found");
      out.machine_id = machine.id;
    }
  }
  if (body.areas !== undefined) {
    if (!Array.isArray(body.areas) || body.areas.some((a) => !GREEN_APPLICATION_AREAS.includes(a as any))) {
      throw new InputError("Unknown area");
    }
    out.areas = JSON.stringify([...new Set(body.areas as string[])]);
  }
  for (const [key, column, label, max] of [
    ["areaDetails", "area_details", "Area details", 500],
    ["nozzle", "nozzle", "Nozzle", 200],
    ["reason", "reason", "Reason", 1000],
    ["operatorCertificate", "operator_certificate", "Operator certificate", 200],
    ["weather", "weather", "Weather", 300],
    ["wind", "wind", "Wind", 200],
    ["notes", "notes", "Notes", 2000],
  ] as const) {
    const value = textField(body, key, label, max);
    if (value !== undefined) out[column] = value;
  }
  for (const [key, column, label] of [
    ["areaHectares", "area_hectares", "Area treated"],
    ["waterVolumeLitres", "water_volume_litres", "Water volume"],
  ] as const) {
    const value = quantityField(body, key, label);
    if (value !== undefined) out[column] = value;
  }
  if (body.temperatureC !== undefined) {
    const t = body.temperatureC === null || body.temperatureC === "" ? null : Number(body.temperatureC);
    if (t !== null && (!Number.isFinite(t) || t < -50 || t > 60)) throw new InputError("Temperature must be between -50 and 60 °C");
    out.temperature_c = t === null ? null : Math.round(t * 10) / 10;
  }

  const operatorName = textField(body, "operatorName", "Operator", 200);
  const rosterId = body.operatorRosterId === undefined ? undefined : body.operatorRosterId === null ? null : Number(body.operatorRosterId);
  const performer = existing
    ? await resolveStaffPerformerUpdate(clientId, rosterId, operatorName, existing.operator_roster_id, existing.operator_name)
    : await resolveStaffPerformer(clientId, rosterId ?? null, operatorName ?? null);
  if (rosterId != null && !performer) throw new InputError("Invalid staff roster member");
  out.operator_name = performer?.performedBy ?? null;
  out.operator_roster_id = performer?.staffRosterId ?? null;

  let products: ApplicationProductInput[] | undefined;
  if (body.products !== undefined || !existing) {
    if (!Array.isArray(body.products) || body.products.length === 0) throw new InputError("Add at least one product");
    if (body.products.length > MAX_PRODUCTS_PER_APPLICATION) throw new InputError(`Up to ${MAX_PRODUCTS_PER_APPLICATION} products per record`);
    products = body.products.map((raw: any) => {
      const item = (raw ?? {}) as Body;
      const quantityUsed = quantityField(item, "quantityUsed", "Quantity used");
      if (quantityUsed == null || quantityUsed <= 0) throw new InputError("Enter the quantity used for each product");
      const rate = quantityField(item, "ratePerHectare", "Rate");
      return { productId: Number(item.productId) || 0, ratePerHectare: rate ?? null, quantityUsed };
    });
    const ids = [...new Set(products.map((p) => p.productId))];
    if (ids.length !== products.length) throw new InputError("Each product can only be listed once");
    const found = rows(await db.execute(sql`
      SELECT id, category FROM green_products
       WHERE client_id = ${clientId} AND id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `));
    if (found.length !== ids.length) throw new InputError("Product not found");
  }

  // Where the products were applied: one area ticked, or a description.
  const areas = out.areas !== undefined ? JSON.parse(out.areas as string) : existing?.areas ?? [];
  const areaDetails = out.area_details !== undefined ? out.area_details : existing?.area_details ?? null;
  if (areas.length === 0 && !areaDetails) throw new InputError("Say where it was applied");
  if (!out.operator_name) throw new InputError("Say who applied it");
  return { columns: out, products };
}

/** Products whose stock is now below zero, to warn about on save. */
async function negativeStock(clientId: number, productIds: number[]) {
  if (!productIds.length) return [];
  const stock = stockOnHand(await greenStockLedger(clientId));
  const names = rows(await db.execute(sql`
    SELECT id, name, unit FROM green_products
     WHERE client_id = ${clientId} AND id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
  `));
  return names
    .map((p: any) => ({ productId: p.id, productName: p.name, unit: p.unit, stockOnHand: stock.get(p.id) ?? 0 }))
    .filter((p) => p.stockOnHand < 0);
}

router.get("/applications", async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const { from, to, productId, limit } = req.query as Record<string, string | undefined>;
    const max = Math.min(Math.max(parseInt(limit ?? "200", 10) || 200, 1), 1000);
    const filters = [
      from && ISO_DATE.test(from) ? sql`AND a.application_date >= ${from}::date` : sql``,
      to && ISO_DATE.test(to) ? sql`AND a.application_date <= ${to}::date` : sql``,
      productId && /^\d+$/.test(productId)
        ? sql`AND EXISTS (SELECT 1 FROM green_application_products f WHERE f.application_id = a.id AND f.client_id = a.client_id AND f.product_id = ${productId})`
        : sql``,
    ];
    res.json(await applicationsWhere(clientId, sql.join(filters, sql` `), max));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch spraying records" });
  }
});

router.post("/applications", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const { columns: c, products } = await applicationInput(clientId, req.body ?? {}, null);
    const id = await db.transaction(async (tx) => {
      const inserted = (await tx.execute(sql`
        INSERT INTO green_applications (
          client_id, application_date, start_time, end_time, method, machine_id, areas, area_details, area_hectares,
          water_volume_litres, nozzle, reason, operator_name, operator_roster_id, operator_certificate,
          weather, wind, temperature_c, notes, created_by
        ) VALUES (
          ${clientId}, ${c.application_date}, ${c.start_time ?? null}, ${c.end_time ?? null}, ${c.method ?? "spray"},
          ${c.machine_id ?? null}, ${c.areas ?? "[]"}::jsonb, ${c.area_details ?? null}, ${c.area_hectares ?? null},
          ${c.water_volume_litres ?? null}, ${c.nozzle ?? null}, ${c.reason ?? null}, ${c.operator_name}, ${c.operator_roster_id},
          ${c.operator_certificate ?? null}, ${c.weather ?? null}, ${c.wind ?? null}, ${c.temperature_c ?? null},
          ${c.notes ?? null}, ${req.currentUser!.id}
        )
        RETURNING id
      `)).rows[0] as { id: number };
      for (const p of products!) {
        await tx.execute(sql`
          INSERT INTO green_application_products (client_id, application_id, product_id, rate_per_hectare, quantity_used)
          VALUES (${clientId}, ${inserted.id}, ${p.productId}, ${p.ratePerHectare}, ${p.quantityUsed})
        `);
      }
      return inserted.id;
    });
    const [application] = await applicationsWhere(clientId, sql`AND a.id = ${id}`, 1);
    res.status(201).json({ ...application, stockWarnings: await negativeStock(clientId, products!.map((p) => p.productId)) });
  } catch (err) {
    sendError(res, err, "Failed to save spraying record");
  }
});

router.put("/applications/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const existing = rows(await db.execute(sql`
      SELECT * FROM green_applications WHERE id = ${req.params.id} AND client_id = ${clientId}
    `))[0] as any;
    if (!existing) return res.status(404).json({ error: "Spraying record not found" });
    const { columns: c, products } = await applicationInput(clientId, req.body ?? {}, existing);
    const value = (column: string, cast = sql``) => c[column] === undefined ? sql.raw(`"${column}"`) : sql`${c[column]}${cast}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE green_applications
           SET application_date = ${value("application_date", sql`::date`)}, start_time = ${value("start_time")},
               end_time = ${value("end_time")}, method = ${value("method")}, machine_id = ${value("machine_id")},
               areas = ${value("areas", sql`::jsonb`)}, area_details = ${value("area_details")},
               area_hectares = ${value("area_hectares")}, water_volume_litres = ${value("water_volume_litres")},
               nozzle = ${value("nozzle")}, reason = ${value("reason")},
               operator_name = ${c.operator_name}, operator_roster_id = ${c.operator_roster_id},
               operator_certificate = ${value("operator_certificate")}, weather = ${value("weather")},
               wind = ${value("wind")}, temperature_c = ${value("temperature_c")}, notes = ${value("notes")},
               updated_at = now()
         WHERE id = ${existing.id} AND client_id = ${clientId}
      `);
      if (products) {
        await tx.execute(sql`DELETE FROM green_application_products WHERE application_id = ${existing.id} AND client_id = ${clientId}`);
        for (const p of products) {
          await tx.execute(sql`
            INSERT INTO green_application_products (client_id, application_id, product_id, rate_per_hectare, quantity_used)
            VALUES (${clientId}, ${existing.id}, ${p.productId}, ${p.ratePerHectare}, ${p.quantityUsed})
          `);
        }
      }
    });
    const [application] = await applicationsWhere(clientId, sql`AND a.id = ${existing.id}`, 1);
    const productIds = (application.products as { productId: number }[]).map((p) => p.productId);
    res.json({ ...application, stockWarnings: await negativeStock(clientId, productIds) });
  } catch (err) {
    sendError(res, err, "Failed to update spraying record");
  }
});

// Deleting a record puts its products back on stock.
router.delete("/applications/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`DELETE FROM green_applications WHERE id = ${req.params.id} AND client_id = ${clientId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete spraying record" });
  }
});

export default router;
