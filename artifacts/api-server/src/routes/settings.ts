import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, usersTable } from "@workspace/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireClientAdmin, getClientId } from "../middleware/requireAuth";
import { parseFixTrackStaleDays } from "../lib/fixTrackAlertSettings";
import {
  CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING,
  MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
  MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
  parseContractorComplianceLeadDays,
} from "../lib/contractorComplianceReminders";

const router: IRouter = Router();

const TRACK_SUMMARY_MODULES = new Set([
  "daily_am", "daily_pm", "kitchen", "fire", "legionella", "pool", "pat",
  "pest", "fix", "premises", "doc", "safe", "train", "hot_tub", "tree",
  "bike", "green", "swim", "incident", "room",
]);

const SETTING_KEYS = [
  "smtpFrom",
  "smtpFromName",
  "defaultLeadTimeDays",
  CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING,
  "companyName",
  "maintenanceEmail",
  "additionalReminderEmails",
  "notifyClientAdmins",
  "resendApiKey",
  // FixTrack: days an open issue may sit unactioned before managers are chased.
  "fixTrackStaleDays",
  // One-time email setup guide — "true" once the admin has dismissed it.
  "emailSetupGuideDismissed",
  // Client-defined notification email — all automated digest/alert emails for
  // this client go here instead of to individual admin user addresses.
  "notificationEmail",
  // JSON map of operational module keys to the active manager user IDs who
  // should receive that track's daily action summary.
  "trackSummaryRouting",
  // Account-level warning only; reaching it never blocks or deletes uploads.
  "storageWarningThresholdBytes",
] as const;

async function validateTrackSummaryRouting(
  clientId: number,
  value: string | null,
): Promise<{ valid: true; value: string | null } | { valid: false; error: string }> {
  if (value == null || value.trim() === "") return { valid: true, value: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { valid: false, error: "Track summary routing must be valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, error: "Track summary routing must be an object" };
  }

  const normalized: Record<string, number[]> = {};
  const requestedIds = new Set<number>();
  for (const [module, rawIds] of Object.entries(parsed as Record<string, unknown>)) {
    if (!TRACK_SUMMARY_MODULES.has(module)) {
      return { valid: false, error: `Unknown track: ${module}` };
    }
    if (!Array.isArray(rawIds)) {
      return { valid: false, error: `Recipients for ${module} must be a list` };
    }
    const ids = [...new Set(rawIds.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      return { valid: false, error: `Recipients for ${module} contain an invalid user` };
    }
    normalized[module] = ids;
    ids.forEach((id) => requestedIds.add(id));
  }

  if (requestedIds.size > 0) {
    const eligible = await db
      .select({ id: usersTable.id, role: usersTable.role })
      .from(usersTable)
      .where(and(
        eq(usersTable.clientId, clientId),
        eq(usersTable.active, true),
        inArray(usersTable.id, [...requestedIds]),
      ));
    const eligibleIds = new Set(
      eligible
        .filter((user) => user.role === "client_admin" || user.role === "client_staff")
        .map((user) => user.id),
    );
    if ([...requestedIds].some((id) => !eligibleIds.has(id))) {
      return { valid: false, error: "Every track recipient must be an active manager in this client account" };
    }
  }

  return { valid: true, value: JSON.stringify(normalized) };
}

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
  if (rawBody.trackSummaryRouting !== undefined) {
    const validated = await validateTrackSummaryRouting(clientId, rawBody.trackSummaryRouting);
    if (!validated.valid) {
      res.status(400).json({ error: validated.error });
      return;
    }
    rawBody.trackSummaryRouting = validated.value;
  }
  if (rawBody.fixTrackStaleDays !== undefined) {
    const parsed = parseFixTrackStaleDays(rawBody.fixTrackStaleDays);
    if (parsed === null) {
      res.status(400).json({ error: "FixTrack escalation timing must be a whole number between 1 and 365 days" });
      return;
    }
    rawBody.fixTrackStaleDays = String(parsed);
  }
  if (rawBody[CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING] !== undefined) {
    const rawLeadDays = rawBody[CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING];
    if (rawLeadDays === null || rawLeadDays.trim() === "") {
      rawBody[CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING] = null;
    } else {
      const parsed = parseContractorComplianceLeadDays(rawLeadDays);
      if (parsed === null) {
        res.status(400).json({
          error: `Contractor reminder lead time must be a whole number between ${MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS} and ${MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS} days`,
        });
        return;
      }
      rawBody[CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING] = String(parsed);
    }
  }
  if (rawBody.storageWarningThresholdBytes !== undefined) {
    if (rawBody.storageWarningThresholdBytes === null) {
      rawBody.storageWarningThresholdBytes = null;
    } else {
    const threshold = Number(rawBody.storageWarningThresholdBytes);
    const min = 1024 * 1024;
    const max = 10 * 1024 * 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(threshold) || threshold < min || threshold > max) {
      res.status(400).json({ error: "Storage warning threshold must be between 1 MB and 10 TB" });
      return;
    }
    rawBody.storageWarningThresholdBytes = String(threshold);
    }
  }

  for (const key of SETTING_KEYS) {
    const value = rawBody[key];
    if (value !== undefined) {
      await db
        .insert(appSettingsTable)
        .values({ clientId, key, value: value ?? null, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [appSettingsTable.clientId, appSettingsTable.key],
          set: { value: value ?? null, updatedAt: new Date() },
        });
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
