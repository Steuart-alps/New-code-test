import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, departmentsTable, usersTable } from "@workspace/db/schema";
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
import {
  ACCOUNT_TIMEZONE_SETTING,
  isValidAccountTimezone,
} from "../middleware/dailyEntryCutoff";
import {
  SAFE_TRACK_REMINDER_FREQUENCY_SETTING,
  SAFE_TRACK_REMINDER_TIME_SETTING,
} from "../lib/safeTrackAckReminders";
import { REQUIRE_TWO_FACTOR_SETTING } from "../lib/twoFactorPolicy";

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
  SAFE_TRACK_REMINDER_FREQUENCY_SETTING,
  SAFE_TRACK_REMINDER_TIME_SETTING,
  // JSON map of operational module keys to the active manager user IDs who
  // should receive that track's daily action summary.
  "trackSummaryRouting",
  // Account-level warning only; reaching it never blocks or deletes uploads.
  "storageWarningThresholdBytes",
  ACCOUNT_TIMEZONE_SETTING,
  // "false" lets login accounts in this business skip the authenticator app;
  // absent or "true" keeps two-factor authentication mandatory.
  REQUIRE_TWO_FACTOR_SETTING,
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

  const normalized: Record<string, { managerIds: number[]; departmentIds: number[] }> = {};
  const requestedIds = new Set<number>();
  const requestedDepartments = new Set<number>();
  for (const [module, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!TRACK_SUMMARY_MODULES.has(module)) {
      return { valid: false, error: `Unknown track: ${module}` };
    }
    const entry = Array.isArray(rawEntry) ? { managerIds: rawEntry, departmentIds: [] } : rawEntry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some((key) => key !== "managerIds" && key !== "departmentIds") ||
        !Array.isArray((entry as any).managerIds) || !Array.isArray((entry as any).departmentIds)) {
      return { valid: false, error: `Recipients for ${module} must include managerIds and departmentIds lists` };
    }
    const rawManagers = (entry as { managerIds: unknown[] }).managerIds;
    const rawDepartments = (entry as { departmentIds: unknown[] }).departmentIds;
    const validId = (id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
    if (rawManagers.some((id) => !validId(id)) || rawDepartments.some((id) => !validId(id))) {
      return { valid: false, error: `Recipients for ${module} contain an invalid user` };
    }
    const managerIds = [...new Set(rawManagers as number[])];
    const departmentIds = [...new Set(rawDepartments as number[])];
    normalized[module] = { managerIds, departmentIds };
    managerIds.forEach((id) => requestedIds.add(id));
    departmentIds.forEach((id) => requestedDepartments.add(id));
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
  if (requestedDepartments.size > 0) {
    const departments = await db.select({ id: departmentsTable.id }).from(departmentsTable)
      .where(and(eq(departmentsTable.clientId, clientId), inArray(departmentsTable.id, [...requestedDepartments])));
    if (departments.length !== requestedDepartments.size) {
      return { valid: false, error: "Every track department must belong to this client account" };
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
  if (rawBody[ACCOUNT_TIMEZONE_SETTING] !== undefined) {
    const rawTimezone = rawBody[ACCOUNT_TIMEZONE_SETTING];
    if (rawTimezone === null || rawTimezone.trim() === "") {
      rawBody[ACCOUNT_TIMEZONE_SETTING] = null;
    } else if (!isValidAccountTimezone(rawTimezone)) {
      res.status(400).json({
        error: "Account timezone must be a valid IANA timezone such as Europe/London",
      });
      return;
    } else {
      rawBody[ACCOUNT_TIMEZONE_SETTING] = rawTimezone.trim();
    }
  }
  if (rawBody[REQUIRE_TWO_FACTOR_SETTING] !== undefined) {
    const rawRequired = rawBody[REQUIRE_TWO_FACTOR_SETTING];
    if (rawRequired !== null && rawRequired !== "true" && rawRequired !== "false") {
      res.status(400).json({ error: "Two-factor requirement must be true or false" });
      return;
    }
    req.log.info(
      { clientId, actorId: req.currentUser!.id, required: rawRequired !== "false" },
      "Two-factor requirement changed",
    );
  }
  if (rawBody[SAFE_TRACK_REMINDER_FREQUENCY_SETTING] !== undefined) {
    const rawFrequency = rawBody[SAFE_TRACK_REMINDER_FREQUENCY_SETTING];
    if (rawFrequency === null || rawFrequency.trim() === "") {
      rawBody[SAFE_TRACK_REMINDER_FREQUENCY_SETTING] = null;
    } else if (rawFrequency !== "daily" && rawFrequency !== "weekly") {
      res.status(400).json({ error: "SafeTrack reminder frequency must be daily or weekly" });
      return;
    }
  }
  if (rawBody[SAFE_TRACK_REMINDER_TIME_SETTING] !== undefined) {
    const rawTime = rawBody[SAFE_TRACK_REMINDER_TIME_SETTING];
    if (rawTime === null || rawTime.trim() === "") {
      rawBody[SAFE_TRACK_REMINDER_TIME_SETTING] = null;
    } else if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rawTime)) {
      res.status(400).json({ error: "SafeTrack reminder time must use 24-hour HH:MM format" });
      return;
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
