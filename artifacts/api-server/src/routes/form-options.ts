import { Router } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireClientAdmin, denyViewers, getClientId } from "../middleware/requireAuth";
import {
  FORM_OPTION_DEFAULTS, FORM_OPTION_KEYS, isFormOptionKey, settingKey,
  validateOptionList, type FormOptionKey,
} from "../lib/formOptions";

const router = Router();

/**
 * GET /api/form-options
 * Returns the effective option list for every whitelisted key for the caller's
 * client: the saved custom list where present, otherwise the default. Also
 * returns the defaults so the web "Customise options" UI can offer a reset.
 */
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db.select({ key: appSettingsTable.key, value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.clientId, clientId));

  const saved = new Map<string, string>();
  for (const row of rows) if (row.value != null) saved.set(row.key, row.value);

  const options: Record<string, string[]> = {};
  const defaults: Record<string, string[]> = {};
  const customised: Record<string, boolean> = {};

  for (const key of FORM_OPTION_KEYS) {
    const def = [...FORM_OPTION_DEFAULTS[key]];
    defaults[key] = def;
    const raw = saved.get(settingKey(key));
    let effective = def;
    let isCustom = false;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const check = validateOptionList(parsed);
        if (check.ok) { effective = check.value; isCustom = true; }
      } catch { /* keep default */ }
    }
    options[key] = effective;
    customised[key] = isCustom;
  }

  res.json({ options, defaults, customised });
});

/**
 * PUT /api/form-options/:key  { items: string[] }
 * Save a custom list. Admin-only.
 */
router.put("/:key", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const key = String(req.params.key);
  if (!isFormOptionKey(key)) return res.status(400).json({ error: "Unknown option key" });

  const check = validateOptionList(req.body?.items);
  if (!check.ok) return res.status(400).json({ error: check.error });

  await saveOption(clientId, key, check.value);
  res.json({ ok: true, items: check.value });
});

/**
 * DELETE /api/form-options/:key
 * Reset a list to its default (removes the saved override). Admin-only.
 */
router.delete("/:key", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const key = String(req.params.key);
  if (!isFormOptionKey(key)) return res.status(400).json({ error: "Unknown option key" });

  await db.delete(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, settingKey(key))));

  res.json({ ok: true, items: [...FORM_OPTION_DEFAULTS[key]] });
});

async function saveOption(clientId: number, key: FormOptionKey, items: string[]) {
  const value = JSON.stringify(items);
  const existing = await db.select({ clientId: appSettingsTable.clientId }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, settingKey(key)))).limit(1);
  if (existing.length > 0) {
    await db.update(appSettingsTable).set({ value, updatedAt: new Date() })
      .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, settingKey(key))));
  } else {
    await db.insert(appSettingsTable).values({ clientId, key: settingKey(key), value });
  }
}

export default router;
