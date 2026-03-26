import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

const SETTING_KEYS = [
  "smtpHost",
  "smtpPort",
  "smtpUser",
  "smtpPass",
  "smtpFrom",
  "smtpFromName",
  "defaultLeadTimeDays",
  "companyName",
] as const;

router.get("/settings", async (_req, res) => {
  const rows = await db.select().from(appSettingsTable);
  const settings: Record<string, string | null> = {};
  for (const key of SETTING_KEYS) {
    settings[key] = null;
  }
  for (const row of rows) {
    settings[row.key] = row.value ?? null;
  }
  res.json(settings);
});

router.put("/settings", async (req, res) => {
  const body = UpdateSettingsBody.parse(req.body);

  for (const key of SETTING_KEYS) {
    const value = (body as Record<string, string | null | undefined>)[key];
    if (value !== undefined) {
      await db
        .insert(appSettingsTable)
        .values({ key, value: value ?? null, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: appSettingsTable.key,
          set: { value: value ?? null, updatedAt: new Date() },
        });
    }
  }

  const rows = await db.select().from(appSettingsTable);
  const settings: Record<string, string | null> = {};
  for (const k of SETTING_KEYS) settings[k] = null;
  for (const row of rows) settings[row.key] = row.value ?? null;
  res.json(settings);
});

export default router;
