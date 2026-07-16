import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireClientAdmin, getClientId } from "../middleware/requireAuth";

const router: IRouter = Router();

const SETTING_KEYS = [
  "smtpFrom",
  "smtpFromName",
  "defaultLeadTimeDays",
  "companyName",
  "maintenanceEmail",
  "additionalReminderEmails",
  "notifyClientAdmins",
  "resendApiKey",
] as const;

router.get("/settings", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.clientId, clientId));

  const settings: Record<string, string | null> = {};
  for (const key of SETTING_KEYS) {
    settings[key] = null;
  }
  for (const row of rows) {
    settings[row.key] = row.value ?? null;
  }
  res.json(settings);
});

router.put("/settings", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  // Validate the standard fields with the generated zod schema, but read all
  // whitelisted setting keys directly from req.body so that newer / non-spec
  // keys (maintenanceEmail, additionalReminderEmails, notifyClientAdmins) are
  // not silently stripped by the schema.
  UpdateSettingsBody.parse(req.body);
  const rawBody = (req.body ?? {}) as Record<string, string | null | undefined>;

  for (const key of SETTING_KEYS) {
    const value = rawBody[key];
    if (value !== undefined) {
      const existing = await db
        .select()
        .from(appSettingsTable)
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));

      if (existing.length > 0) {
        await db
          .update(appSettingsTable)
          .set({ value: value ?? null, updatedAt: new Date() })
          .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
      } else {
        await db
          .insert(appSettingsTable)
          .values({ clientId, key, value: value ?? null, updatedAt: new Date() });
      }
    }
  }

  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.clientId, clientId));

  const settings: Record<string, string | null> = {};
  for (const k of SETTING_KEYS) settings[k] = null;
  for (const row of rows) settings[row.key] = row.value ?? null;
  res.json(settings);
});

export default router;
