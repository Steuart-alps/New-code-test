import { Router, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { consultantBrandingTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { requireAuth, requireConsultant, getClientId } from "../middleware/requireAuth";
import {
  ObjectContentError,
  ObjectGenerationError,
  ObjectNotFoundError,
  ObjectOwnershipError,
  ObjectStorageService,
  type AllowedUploadType,
} from "../lib/objectStorage";
import { respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import {
  MAX_BRANDING_LOGO_BYTES,
  brandingStorageTenant,
  getConsultantBranding,
  readConsultantBrandingLogo,
} from "../lib/consultantBranding";

// Consultant portfolio overview and practice branding.
//
// The portfolio covers exactly the businesses in req.allowedClientIds (the
// consultant_clients membership loaded by loadUser, as GET /clients uses);
// no client id is ever read from the request. Each metric is one aggregate
// query across those ids rather than one dashboard call per business.

const router = Router();
const storage = new ObjectStorageService();
const LOGO_TYPES = new Set<AllowedUploadType>(["image/png", "image/jpeg", "image/webp"]);

const rowsOf = <T>(result: unknown) => ((result as { rows?: unknown[] }).rows ?? []) as T[];
const countMap = (rows: Array<{ client_id: number; n: number | string }>) =>
  new Map(rows.map((row) => [Number(row.client_id), Number(row.n)]));

type SubscriptionState = "subscribed" | "past_due" | "cancelling" | "trial" | "trial_ended" | "cancelled" | "unknown";

async function liveSubscriptions(customerIds: string[]) {
  if (!customerIds.length) return new Map<string, { status: string; cancel_at_period_end: boolean | null }[]>();
  try {
    // The synced Stripe mirror (stripe.*) is absent in databases that never
    // connected Stripe; report "unknown" then rather than failing the page.
    const present = rowsOf<{ present: boolean }>(await db.execute(sql`SELECT to_regclass('stripe.subscriptions') IS NOT NULL AS present`))[0]?.present;
    if (!present) return null;
    const rows = rowsOf<{ customer: string; status: string; cancel_at_period_end: boolean | null }>(await db.execute(sql`
      SELECT customer, status, cancel_at_period_end FROM stripe.subscriptions
      WHERE customer IN (${sql.join(customerIds.map((id) => sql`${id}`), sql`, `)})
    `));
    const byCustomer = new Map<string, typeof rows>();
    for (const row of rows) byCustomer.set(row.customer, [...(byCustomer.get(row.customer) ?? []), row]);
    return byCustomer;
  } catch {
    return null;
  }
}

function subscriptionState(
  client: { trial_ends_at: Date | string | null; stripe_customer_id: string | null; cancelled_at: Date | string | null },
  subscriptions: Map<string, { status: string; cancel_at_period_end: boolean | null }[]> | null,
): SubscriptionState {
  const subs = client.stripe_customer_id && subscriptions ? subscriptions.get(client.stripe_customer_id) ?? [] : [];
  const live = subs.find((sub) => ["active", "trialing", "past_due"].includes(sub.status));
  if (live) return live.status === "past_due" ? "past_due" : live.cancel_at_period_end ? "cancelling" : "subscribed";
  if (!client.trial_ends_at || new Date(client.trial_ends_at).getTime() > Date.now()) return "trial";
  if (client.stripe_customer_id && subscriptions === null) return "unknown";
  return client.cancelled_at ? "cancelled" : "trial_ended";
}

router.get("/portfolio", requireAuth, requireConsultant, async (req, res) => {
  const ids = Array.from(req.allowedClientIds ?? []).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return res.json({ businesses: [] });
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

  const [clients, sites, overdueChecks, actions, activity] = await Promise.all([
    db.execute(sql`
      SELECT id, name, active, trial_ends_at, stripe_customer_id, cancelled_at
      FROM clients WHERE id IN (${idList}) ORDER BY lower(name), id
    `),
    db.execute(sql`SELECT client_id, count(*) AS n FROM sites WHERE client_id IN (${idList}) GROUP BY client_id`),
    // Same rule as the dashboard stats: past due and not completed counts as overdue.
    db.execute(sql`
      SELECT client_id, count(*) AS n FROM compliance_items
      WHERE client_id IN (${idList}) AND status <> 'completed' AND (status = 'overdue' OR due_date < now())
      GROUP BY client_id
    `),
    // Failed track checks open remediation actions, so open actions cover them.
    db.execute(sql`
      SELECT client_id,
             count(*) AS open,
             count(*) FILTER (WHERE due_date < current_date) AS overdue
      FROM track_actions
      WHERE client_id IN (${idList}) AND status IN ('open', 'in_progress')
      GROUP BY client_id
    `),
    db.execute(sql`
      SELECT client_id, max(at) AS last_activity_at FROM (
        SELECT client_id, max(changed_at) AS at FROM audit_log WHERE client_id IN (${idList}) GROUP BY client_id
        UNION ALL
        SELECT client_id, max(created_at)::timestamptz FROM audit_events WHERE client_id IN (${idList}) GROUP BY client_id
        UNION ALL
        SELECT client_id, max(updated_at)::timestamptz FROM compliance_items WHERE client_id IN (${idList}) GROUP BY client_id
        UNION ALL
        SELECT client_id, max(updated_at)::timestamptz FROM track_actions WHERE client_id IN (${idList}) GROUP BY client_id
      ) recent GROUP BY client_id
    `),
  ]);

  const clientRows = rowsOf<{ id: number; name: string; active: boolean; trial_ends_at: Date | null; stripe_customer_id: string | null; cancelled_at: Date | null }>(clients);
  const subscriptions = await liveSubscriptions([...new Set(clientRows.map((row) => row.stripe_customer_id).filter((id): id is string => !!id))]);
  const siteCounts = countMap(rowsOf(sites));
  const overdueCounts = countMap(rowsOf(overdueChecks));
  const actionCounts = new Map(rowsOf<{ client_id: number; open: string; overdue: string }>(actions)
    .map((row) => [Number(row.client_id), { open: Number(row.open), overdue: Number(row.overdue) }]));
  const lastActivity = new Map(rowsOf<{ client_id: number; last_activity_at: Date | string | null }>(activity)
    .map((row) => [Number(row.client_id), row.last_activity_at]));

  res.json({
    businesses: clientRows.map((client) => ({
      id: Number(client.id),
      name: client.name,
      active: client.active,
      sites: siteCounts.get(Number(client.id)) ?? 0,
      overdueChecks: overdueCounts.get(Number(client.id)) ?? 0,
      openActions: actionCounts.get(Number(client.id))?.open ?? 0,
      overdueActions: actionCounts.get(Number(client.id))?.overdue ?? 0,
      lastActivityAt: lastActivity.get(Number(client.id)) ?? null,
      subscription: subscriptionState(client, subscriptions),
      trialEndsAt: client.trial_ends_at,
    })),
  });
});

// ── Practice branding (the consultant's own settings) ────────────────────────

async function ownBranding(userId: number) {
  const [row] = await db.select().from(consultantBrandingTable).where(eq(consultantBrandingTable.consultantUserId, userId)).limit(1);
  return row;
}

router.get("/consultant-branding", requireAuth, requireConsultant, async (req, res) => {
  const row = await ownBranding(req.currentUser!.id);
  res.json({ practiceName: row?.practiceName ?? null, hasLogo: !!row?.logoObjectPath, updatedAt: row?.updatedAt ?? null });
});

const brandingBody = z.object({ practiceName: z.string().trim().max(120).nullable() });

router.put("/consultant-branding", requireAuth, requireConsultant, async (req, res) => {
  const parsed = brandingBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Practice name must be 120 characters or fewer" });
  const practiceName = parsed.data.practiceName || null;
  await db.insert(consultantBrandingTable)
    .values({ consultantUserId: req.currentUser!.id, practiceName })
    .onConflictDoUpdate({ target: consultantBrandingTable.consultantUserId, set: { practiceName, updatedAt: new Date() } });
  const row = await ownBranding(req.currentUser!.id);
  res.json({ practiceName: row?.practiceName ?? null, hasLogo: !!row?.logoObjectPath, updatedAt: row?.updatedAt ?? null });
});

const logoRequestBody = z.object({
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size: z.number().int().positive().max(MAX_BRANDING_LOGO_BYTES),
});

router.post("/consultant-branding/logo/request-url", requireAuth, requireConsultant, async (req, res) => {
  const parsed = logoRequestBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Logo must be a PNG, JPEG or WebP image of 2 MB or less" });
  try {
    const uploadURL = await storage.getObjectEntityUploadURL(brandingStorageTenant(req.currentUser!.id), parsed.data.contentType);
    res.json({ uploadURL, objectPath: storage.normalizeObjectEntityPath(uploadURL) });
  } catch (error) {
    respondObjectStorageUnavailable(req, res, error, "consultant branding logo upload");
  }
});

router.post("/consultant-branding/logo", requireAuth, requireConsultant, async (req, res) => {
  const parsed = z.object({ objectPath: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "objectPath is required" });
  const userId = req.currentUser!.id;
  const tenant = brandingStorageTenant(userId);
  let finalized: { objectPath: string; contentType: AllowedUploadType };
  try {
    // Signature check, full decode and re-encode, then a fresh immutable key
    // owned by the consultant's storage tenant (as for document uploads).
    finalized = await storage.finalizeVerifiedTenantUpload(parsed.data.objectPath, tenant, LOGO_TYPES);
    const [metadata] = await (await storage.getObjectEntityFile(finalized.objectPath)).getMetadata();
    if (Number(metadata.size) > MAX_BRANDING_LOGO_BYTES) {
      await storage.deleteTenantObject(finalized.objectPath, tenant).catch(() => {});
      return res.status(400).json({ error: "Logo must be 2 MB or less" });
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "Uploaded logo not found" });
    if (err instanceof ObjectContentError) {
      await storage.discardTenantUpload(parsed.data.objectPath, tenant).catch(() => {});
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ObjectOwnershipError) return res.status(403).json({ error: err.message });
    if (err instanceof ObjectGenerationError) return res.status(409).json({ error: err.message });
    return respondObjectStorageUnavailable(req, res, err, "consultant branding logo finalization");
  }
  const previous = await ownBranding(userId);
  await db.insert(consultantBrandingTable)
    .values({ consultantUserId: userId, logoObjectPath: finalized.objectPath, logoContentType: finalized.contentType })
    .onConflictDoUpdate({
      target: consultantBrandingTable.consultantUserId,
      set: { logoObjectPath: finalized.objectPath, logoContentType: finalized.contentType, updatedAt: new Date() },
    });
  if (previous?.logoObjectPath && previous.logoObjectPath !== finalized.objectPath) {
    await storage.deleteTenantObject(previous.logoObjectPath, tenant).catch(() => {});
  }
  res.json({ hasLogo: true });
});

router.delete("/consultant-branding/logo", requireAuth, requireConsultant, async (req, res) => {
  const userId = req.currentUser!.id;
  const previous = await ownBranding(userId);
  if (previous?.logoObjectPath) {
    await db.update(consultantBrandingTable)
      .set({ logoObjectPath: null, logoContentType: null, updatedAt: new Date() })
      .where(eq(consultantBrandingTable.consultantUserId, userId));
    await storage.deleteTenantObject(previous.logoObjectPath, brandingStorageTenant(userId)).catch(() => {});
  }
  res.json({ hasLogo: false });
});

async function sendLogo(res: Response, branding: Parameters<typeof readConsultantBrandingLogo>[0] | null | undefined) {
  const logo = branding ? await readConsultantBrandingLogo(branding) : null;
  if (!logo) return res.status(404).json({ error: "No logo" });
  res.setHeader("Content-Type", logo.contentType);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(logo.bytes);
}

router.get("/consultant-branding/logo", requireAuth, requireConsultant, async (req, res) => {
  const row = await ownBranding(req.currentUser!.id);
  await sendLogo(res, row ? { consultantUserId: row.consultantUserId, logoObjectPath: row.logoObjectPath, logoContentType: row.logoContentType } : null);
});

// ── "Managed by" for the business being viewed ────────────────────────────────

router.get("/managed-by", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.json(null);
  const branding = await getConsultantBranding(clientId);
  if (!branding) return res.json(null);
  res.json({ practiceName: branding.practiceName, hasLogo: !!branding.logoObjectPath, updatedAt: branding.updatedAt });
});

router.get("/managed-by/logo", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(404).json({ error: "No logo" });
  await sendLogo(res, await getConsultantBranding(clientId));
});

export default router;
