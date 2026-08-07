import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin } from "../middleware/requireAuth";

const router = Router();

const itemSchema = z.object({
  label: z.string().min(1),
  section: z.string().optional(),
  checked: z.boolean().optional(),
  notes: z.string().optional(),
});

// GET /checklist-templates?type=kitchen_opening&siteId=123
// Returns the custom template for the given type + site, or null if using defaults.
// Lookup order: site-specific > client-level > null (use frontend defaults)
router.get("/checklist-templates", requireAuth, async (req, res) => {
  const clientId = (req as any).clientId as number;
  const { type, siteId } = req.query;

  if (!type || typeof type !== "string") {
    return res.status(400).json({ error: "type is required" });
  }

  const parsedSiteId = siteId ? Number(siteId) : null;

  try {
    // Try site-specific first, then client-level
    let row: any = null;

    if (parsedSiteId) {
      const rows = await db.execute(sql`
        SELECT items FROM checklist_templates
        WHERE client_id = ${clientId}
          AND site_id = ${parsedSiteId}
          AND checklist_type = ${type}
        LIMIT 1
      `);
      row = (rows as any).rows?.[0] ?? (rows as any)[0] ?? null;
    }

    if (!row) {
      const rows = await db.execute(sql`
        SELECT items FROM checklist_templates
        WHERE client_id = ${clientId}
          AND site_id IS NULL
          AND checklist_type = ${type}
        LIMIT 1
      `);
      row = (rows as any).rows?.[0] ?? (rows as any)[0] ?? null;
    }

    if (!row) {
      return res.json({ items: null, isCustom: false });
    }

    const items = typeof row.items === "string" ? JSON.parse(row.items) : row.items;
    return res.json({ items, isCustom: true });
  } catch (err) {
    console.error("GET /checklist-templates error:", err);
    return res.status(500).json({ error: "Failed to fetch template" });
  }
});

// PUT /checklist-templates — save (upsert) a custom template
router.put("/checklist-templates", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = (req as any).clientId as number;
  const userId = (req as any).userId as number;

  const schema = z.object({
    type: z.string().min(1),
    siteId: z.number().nullable().optional(),
    items: z.array(itemSchema).min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  const { type, siteId = null, items } = parsed.data;

  // Strip checked/notes from template items — templates are unchecked blueprints
  const templateItems = items.map(({ label, section }) => ({
    label,
    ...(section ? { section } : {}),
    checked: false,
  }));

  try {
    if (siteId) {
      await db.execute(sql`
        INSERT INTO checklist_templates (client_id, site_id, checklist_type, items, updated_by, updated_at)
        VALUES (${clientId}, ${siteId}, ${type}, ${JSON.stringify(templateItems)}::jsonb, ${userId}, now())
        ON CONFLICT (client_id, site_id, checklist_type) WHERE site_id IS NOT NULL
          DO UPDATE SET items = EXCLUDED.items, updated_by = EXCLUDED.updated_by, updated_at = now()
      `);
    } else {
      await db.execute(sql`
        INSERT INTO checklist_templates (client_id, site_id, checklist_type, items, updated_by, updated_at)
        VALUES (${clientId}, NULL, ${type}, ${JSON.stringify(templateItems)}::jsonb, ${userId}, now())
        ON CONFLICT (client_id, checklist_type) WHERE site_id IS NULL
          DO UPDATE SET items = EXCLUDED.items, updated_by = EXCLUDED.updated_by, updated_at = now()
      `);
    }
    return res.json({ ok: true, items: templateItems });
  } catch (err) {
    console.error("PUT /checklist-templates error:", err);
    return res.status(500).json({ error: "Failed to save template" });
  }
});

// DELETE /checklist-templates?type=kitchen_opening&siteId=123 — reset to default
router.delete("/checklist-templates", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = (req as any).clientId as number;
  const { type, siteId } = req.query;

  if (!type || typeof type !== "string") {
    return res.status(400).json({ error: "type is required" });
  }

  const parsedSiteId = siteId ? Number(siteId) : null;

  try {
    if (parsedSiteId) {
      await db.execute(sql`
        DELETE FROM checklist_templates
        WHERE client_id = ${clientId} AND site_id = ${parsedSiteId} AND checklist_type = ${type}
      `);
    } else {
      await db.execute(sql`
        DELETE FROM checklist_templates
        WHERE client_id = ${clientId} AND site_id IS NULL AND checklist_type = ${type}
      `);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /checklist-templates error:", err);
    return res.status(500).json({ error: "Failed to reset template" });
  }
});

export default router;
