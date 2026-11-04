/**
 * Frost warnings. Each afternoon, every site whose address has a UK postcode
 * gets its overnight forecast checked; when the low between 18:00 and 09:00
 * (the business's local time) is below FROST_WARNING_BELOW_C, the people who
 * look after the site are told to grit and de-ice before they go home:
 *   - the Maintenance managers who cover the site, else the Managers who do,
 *     else the Owners (one email per person, listing every site of theirs);
 *   - the same people get a bell notification (and phone push);
 *   - everyone who can see the site sees it on the dashboard until midday
 *     the next day.
 * Not tied to any track, so every active business with a site gets it.
 *
 * Free sources, no keys, commercial use allowed:
 *   - postcodes.io (Open Government Licence) turns the postcode into a
 *     latitude and longitude, once per postcode (kept on the site);
 *   - MET Norway's Locationforecast (CC BY 4.0, credited in the email and on
 *     the dashboard) gives the hourly forecast. Its terms ask for a
 *     User-Agent naming the app and a contact, and coordinates of at most
 *     4 decimals; sites are rounded to 2 (about 1 km), so nearby sites share
 *     one request.
 *
 * Light by design: one forecast request per site location per day, made
 * between 15:00 and 22:00 local, one at a time. A failed request is retried
 * the next hour.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { addCalendarDays, getAccountTimezone, localDateIn, zonedDateTimeToUtc } from "./accountClock";
import { canSee, loadResponsibilityContext, type ResponsibilityContext } from "./dueItems";
import {
  claimEmailDelivery,
  emailDeliveryIdempotencyKey,
  markEmailDeliverySent,
  pruneSentEmailDeliveries,
  settleEmailDelivery,
} from "./emailDeliveryClaims";
import { emailButton, escapeHtml, getPublicAppUrl, renderEmailLayout, sendEmail } from "./email";
import { logger } from "./logger";
import { sendPushToUsers } from "./pushNotifications";
import { isClientBillingLocked } from "./trialLock";
import { createUserNotifications, type NewUserNotification } from "./userNotifications";

export const FROST_WARNING_JOB = "frost-warnings";
/** Warn when the overnight low is below this (°C). */
export const FROST_WARNING_BELOW_C = 4;
/** The forecast is checked, and warnings sent, from this local time... */
export const FROST_CHECK_FROM = "15:00";
/** ...until this one (so a late restart doesn't send a warning at midnight). */
export const FROST_CHECK_UNTIL = "22:00";
/** The night runs from this local time... */
const NIGHT_FROM = "18:00";
/** ...to this one the next morning. */
const NIGHT_UNTIL = "09:00";
const REQUEST_TIMEOUT_MS = 10_000;
const SENT_MARKER_DAYS = 30;
/** Forecasts are kept this long (the dashboard only needs tonight's). */
const FORECAST_KEEP_DAYS = 60;

export const FORECAST_CREDIT = "Forecast from MET Norway (CC BY 4.0)";
const POSTCODE_LOOKUP_URL = "https://api.postcodes.io/postcodes/";
const FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

type Fetch = typeof fetch;

export interface FrostWarningJobOptions {
  now?: Date;
  /** Only these businesses (tests); default every active business. */
  clientIds?: number[];
  send?: typeof sendEmail;
  sendPush?: typeof sendPushToUsers;
  /** Replaces the network (tests). */
  fetch?: Fetch;
}

export interface FrostWarningJobResult {
  clientsChecked: number;
  forecastsFetched: number;
  sitesWarned: number;
  emailsSent: number;
  errors: number;
}

// ── Postcodes ────────────────────────────────────────────────────────────────

const POSTCODE_PATTERN = /\b(GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?[0-9][0-9A-HJKMNPR-Y]? ?[0-9][ABD-HJLNP-UW-Z]{2})\b/i;

/** The UK postcode in an address, upper case with one space ("KA3 6AA"), or null. */
export function ukPostcodeIn(address: string | null | undefined): string | null {
  const match = (address ?? "").toUpperCase().match(POSTCODE_PATTERN);
  if (!match) return null;
  const compact = match[1]!.replace(/\s+/g, "");
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function userAgent(): string {
  return `ComplyTrack/1.0 (+${getPublicAppUrl()})`;
}

/** Latitude and longitude of a UK postcode; null when it isn't a known postcode. Throws on a network failure. */
export async function lookUpPostcode(postcode: string, fetcher: Fetch = fetch): Promise<{ latitude: number; longitude: number } | null> {
  const response = await fetcher(`${POSTCODE_LOOKUP_URL}${encodeURIComponent(postcode)}`, {
    headers: { "User-Agent": userAgent(), Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Postcode lookup failed (${response.status})`);
  const body = await response.json() as { result?: { latitude?: number | null; longitude?: number | null } | null };
  const { latitude, longitude } = body.result ?? {};
  return typeof latitude === "number" && typeof longitude === "number" ? { latitude, longitude } : null;
}

// ── Forecast ─────────────────────────────────────────────────────────────────

export interface OvernightLow {
  lowestC: number;
  coldestAt: Date;
}

/**
 * The lowest forecast air temperature between 18:00 on `nightOf` and 09:00
 * the next morning (local time), or null when the forecast has no hours in
 * that window. Throws on a network failure.
 */
export async function fetchOvernightLow(
  latitude: number, longitude: number, nightOf: string, timeZone: string, fetcher: Fetch = fetch,
): Promise<OvernightLow | null> {
  const url = `${FORECAST_URL}?lat=${latitude.toFixed(2)}&lon=${longitude.toFixed(2)}`;
  const response = await fetcher(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Forecast request failed (${response.status})`);
  const body = await response.json() as {
    properties?: { timeseries?: Array<{ time?: string; data?: { instant?: { details?: { air_temperature?: number } } } }> };
  };
  return overnightLow(body.properties?.timeseries ?? [], nightOf, timeZone);
}

/** The coldest hour of the night in a Locationforecast timeseries. */
export function overnightLow(
  series: Array<{ time?: string; data?: { instant?: { details?: { air_temperature?: number } } } }>,
  nightOf: string, timeZone: string,
): OvernightLow | null {
  const from = zonedDateTimeToUtc(nightOf, NIGHT_FROM, timeZone).getTime();
  const until = zonedDateTimeToUtc(addCalendarDays(nightOf, 1), NIGHT_UNTIL, timeZone).getTime();
  let low: OvernightLow | null = null;
  for (const entry of series) {
    const at = entry.time ? Date.parse(entry.time) : NaN;
    const temperature = entry.data?.instant?.details?.air_temperature;
    if (!Number.isFinite(at) || at < from || at > until || typeof temperature !== "number") continue;
    if (!low || temperature < low.lowestC) low = { lowestC: temperature, coldestAt: new Date(at) };
  }
  return low;
}

// ── Who is told ──────────────────────────────────────────────────────────────

/** Maintenance managers who cover the site, else its Managers, else the Owners. */
export function frostRecipients(ctx: ResponsibilityContext, siteId: number): number[] {
  const maintenance = ctx.maintenanceManagerIds.filter((id) => canSee(ctx, id, siteId));
  if (maintenance.length) return maintenance;
  const managers = [...ctx.eligible.values()]
    .filter((user) => user.role === "client_manager" && canSee(ctx, user.id, siteId))
    .map((user) => user.id);
  if (managers.length) return managers;
  return ctx.ownerIds.length ? ctx.ownerIds : ctx.fallback;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface FrostSite {
  siteId: number;
  siteName: string;
  lowestC: number;
  coldestAt: Date | null;
}

export function formatTemperature(celsius: number): string {
  const rounded = Math.round(celsius);
  return `${rounded < 0 ? "−" : ""}${Math.abs(rounded)}°C`;
}

function timeIn(at: Date, timeZone: string): string {
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
}

function describeLow(site: FrostSite, timeZone: string): string {
  return `down to ${formatTemperature(site.lowestC)}${site.coldestAt ? ` around ${timeIn(site.coldestAt, timeZone)}` : ""}`;
}

export function buildFrostWarningEmail(
  businessName: string, sites: FrostSite[], name: string | null, timeZone: string,
): { subject: string; html: string } {
  const appUrl = getPublicAppUrl();
  const subject = sites.length === 1
    ? `Frost tonight at ${sites[0]!.siteName}: grit and de-ice — ComplyTrack`
    : `Frost tonight at ${sites.length} sites: grit and de-ice — ComplyTrack`;
  const rows = sites.map((site) => `<tr>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;font-weight:700;font-size:16px;color:#0f172a;">${escapeHtml(site.siteName)}</td>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;color:#1d4ed8;font-weight:700;">${escapeHtml(describeLow(site, timeZone))}</td>
        </tr>`).join("");
  const html = renderEmailLayout({
    subtitle: "Frost warning",
    bodyHtml: `<p style="margin:0 0 16px;">Hello${name ? ` ${escapeHtml(name.split(" ")[0]!)}` : ""},</p>`
      + `<p style="margin:0 0 6px;font-size:19px;font-weight:700;color:#0f172a;">Tonight's forecast drops below ${FROST_WARNING_BELOW_C}°C at ${escapeHtml(businessName)}.</p>`
      + `<p style="margin:0 0 20px;color:#475569;">Ice is likely on paths, steps and car parks.</p>`
      + `<table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;margin:0 0 20px;">${rows}</table>`
      + `<p style="margin:0 0 8px;font-weight:700;">Before you finish today:</p>`
      + `<ul style="margin:0 0 20px;padding-left:20px;color:#1e293b;">`
      + `<li>Grit paths, steps, ramps, entrances and the car park.</li>`
      + `<li>Make sure grit and de-icer are ready for first thing.</li>`
      + `<li>Check again and de-ice before staff and visitors arrive in the morning.</li>`
      + `</ul>`
      + `<div style="text-align:center;">${emailButton(appUrl, "Open ComplyTrack →")}</div>`,
    footerNote: `Sent when the overnight forecast for a site drops below ${FROST_WARNING_BELOW_C}°C. ${FORECAST_CREDIT}`,
  });
  return { subject, html };
}

// ── The job ──────────────────────────────────────────────────────────────────

interface SiteRow {
  id: number;
  name: string;
  address: string | null;
  location_postcode: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Look up each site's postcode when it is new or changed; returns the sites with a location. */
async function locateSites(sites: SiteRow[], fetcher: Fetch): Promise<Array<SiteRow & { latitude: number; longitude: number }>> {
  const located: Array<SiteRow & { latitude: number; longitude: number }> = [];
  for (const site of sites) {
    const postcode = ukPostcodeIn(site.address);
    if (!postcode) continue;
    let { latitude, longitude } = site;
    if (postcode !== site.location_postcode) {
      const found = await lookUpPostcode(postcode, fetcher);
      latitude = found?.latitude ?? null;
      longitude = found?.longitude ?? null;
      await db.execute(sql`
        UPDATE sites SET location_postcode = ${postcode}, latitude = ${latitude}, longitude = ${longitude} WHERE id = ${site.id}
      `);
    }
    if (latitude != null && longitude != null) located.push({ ...site, latitude: Number(latitude), longitude: Number(longitude) });
  }
  return located;
}

async function frostWarningsForClient(
  clientId: number, now: Date, options: FrostWarningJobOptions, forecasts: Map<string, OvernightLow | null>,
  result: FrostWarningJobResult,
): Promise<void> {
  const timeZone = await getAccountTimezone(clientId);
  const nightOf = localDateIn(timeZone, now);
  if (now < zonedDateTimeToUtc(nightOf, FROST_CHECK_FROM, timeZone) || now >= zonedDateTimeToUtc(nightOf, FROST_CHECK_UNTIL, timeZone)) return;
  if (await isClientBillingLocked(clientId).catch(() => false)) return;
  result.clientsChecked++;
  const fetcher = options.fetch ?? fetch;

  // Check the forecast for sites not yet checked tonight.
  const unchecked = rowsOf<SiteRow>(await db.execute(sql`
    SELECT s.id, s.name, s.address, s.location_postcode, s.latitude, s.longitude
    FROM sites s
    WHERE s.client_id = ${clientId} AND coalesce(trim(s.address), '') <> ''
      AND NOT EXISTS (SELECT 1 FROM frost_forecasts f WHERE f.site_id = s.id AND f.night_of = ${nightOf})
    ORDER BY s.id
  `));
  for (const site of await locateSites(unchecked, fetcher)) {
    const key = `${site.latitude.toFixed(2)},${site.longitude.toFixed(2)}:${nightOf}:${timeZone}`;
    if (!forecasts.has(key)) {
      try {
        forecasts.set(key, await fetchOvernightLow(site.latitude, site.longitude, nightOf, timeZone, fetcher));
        result.forecastsFetched++;
      } catch (err) {
        result.errors++;
        logger.warn({ err, clientId, siteId: site.id }, "Frost warning forecast failed; trying again next hour");
        continue;
      }
    }
    const low = forecasts.get(key);
    if (!low) continue;
    await db.execute(sql`
      INSERT INTO frost_forecasts (client_id, site_id, night_of, lowest_c, coldest_at, warn)
      VALUES (${clientId}, ${site.id}, ${nightOf}, ${low.lowestC}, ${low.coldestAt.toISOString()}::timestamptz, ${low.lowestC < FROST_WARNING_BELOW_C})
      ON CONFLICT (site_id, night_of) DO NOTHING
    `);
  }

  // Tell people about tonight's cold sites (each person once per site and night).
  const cold = rowsOf<{ site_id: number; name: string; lowest_c: number; coldest_at: string | Date | null }>(await db.execute(sql`
    SELECT f.site_id, s.name, f.lowest_c, f.coldest_at
    FROM frost_forecasts f JOIN sites s ON s.id = f.site_id AND s.client_id = f.client_id
    WHERE f.client_id = ${clientId} AND f.night_of = ${nightOf} AND f.warn = true
    ORDER BY s.name, s.id
  `)).map((row): FrostSite => ({
    siteId: Number(row.site_id), siteName: row.name, lowestC: Number(row.lowest_c),
    coldestAt: row.coldest_at ? new Date(row.coldest_at) : null,
  }));
  if (!cold.length) return;
  result.sitesWarned += cold.length;

  const [ctx, clientRows] = await Promise.all([
    loadResponsibilityContext(clientId),
    db.execute(sql`SELECT name FROM clients WHERE id = ${clientId}`),
  ]);
  const businessName = rowsOf<{ name: string }>(clientRows)[0]?.name ?? "your business";
  const byUser = new Map<number, FrostSite[]>();
  for (const site of cold) {
    for (const userId of frostRecipients(ctx, site.siteId)) byUser.set(userId, [...(byUser.get(userId) ?? []), site]);
  }
  const send = options.send ?? sendEmail;
  for (const [userId, sites] of byUser) {
    const user = ctx.eligible.get(userId);
    const email = user?.email?.trim().toLowerCase();
    if (!user || !email) continue;
    const claims = [];
    for (const site of sites) {
      const claim = await claimEmailDelivery(FROST_WARNING_JOB, `${clientId}:${site.siteId}:${nightOf}:${email}`);
      if (claim) claims.push({ site, claim });
    }
    if (!claims.length) continue;
    const { subject, html } = buildFrostWarningEmail(businessName, claims.map((entry) => entry.site), user.name, timeZone);
    try {
      await send({
        to: email, subject, html, clientId,
        idempotencyKey: emailDeliveryIdempotencyKey(claims[0]!.claim, claims.map((entry) => entry.site.siteId).join(",")),
      });
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Frost warning email failed");
      await Promise.all(claims.map((entry) => settleEmailDelivery(entry.claim).catch(() => {})));
      continue;
    }
    await Promise.all(claims.map((entry) => markEmailDeliverySent(entry.claim)));
    result.emailsSent++;
    const bell: NewUserNotification[] = claims.map(({ site }) => ({
      clientId, userId, module: null, siteId: site.siteId, kind: "frost_warning",
      title: `Frost tonight at ${site.siteName}: grit and de-ice`,
      body: `Forecast ${describeLow(site, timeZone)}. Grit paths, steps and the car park before you finish today.`,
      linkPath: "/", dedupeKey: `frost:${site.siteId}:${nightOf}`,
    }));
    try {
      await createUserNotifications(bell, { sendPush: options.sendPush });
    } catch (err) {
      logger.warn({ err, clientId }, "Frost warning notifications failed");
    }
  }
}

/** Hourly. Each business is handled from its own local 15:00 to 22:00. */
export async function runFrostWarningJob(options: FrostWarningJobOptions = {}): Promise<FrostWarningJobResult> {
  const now = options.now ?? new Date();
  const result: FrostWarningJobResult = { clientsChecked: 0, forecastsFetched: 0, sitesWarned: 0, emailsSent: 0, errors: 0 };
  const clientFilter = options.clientIds
    ? options.clientIds.length
      ? sql`AND c.id IN (${sql.join(options.clientIds.map((id) => sql`${id}`), sql`, `)})`
      : sql`AND false`
    : sql``;
  const clients = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT c.id FROM clients c
    WHERE c.active = true ${clientFilter}
      AND EXISTS (SELECT 1 FROM sites s WHERE s.client_id = c.id AND coalesce(trim(s.address), '') <> '')
    ORDER BY c.id
  `));
  // Shared across businesses, so sites near each other cost one request.
  const forecasts = new Map<string, OvernightLow | null>();
  for (const client of clients) {
    try {
      await frostWarningsForClient(Number(client.id), now, options, forecasts, result);
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Frost warning check failed for a business");
    }
  }
  try {
    await pruneSentEmailDeliveries(FROST_WARNING_JOB, SENT_MARKER_DAYS);
    await db.execute(sql`DELETE FROM frost_forecasts WHERE night_of < (CURRENT_DATE - ${FORECAST_KEEP_DAYS}::int)`);
  } catch (err) {
    logger.warn({ err }, "Could not prune frost warning records");
  }
  return result;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

/** From midday the night ahead is "tonight"; before midday it is the night just ending. */
export function frostNightOf(timeZone: string, now: Date): string {
  const today = localDateIn(timeZone, now);
  return now >= zonedDateTimeToUtc(today, "12:00", timeZone) ? today : addCalendarDays(today, -1);
}

export interface FrostWarningsView {
  nightOf: string;
  belowC: number;
  credit: string;
  warnings: Array<{ siteId: number; siteName: string; lowestC: number; coldestAt: string | null }>;
}

/** Tonight's warnings for the given sites. */
export async function frostWarningsFor(clientId: number, siteIds: number[], now: Date = new Date()): Promise<FrostWarningsView> {
  const timeZone = await getAccountTimezone(clientId);
  const nightOf = frostNightOf(timeZone, now);
  const view: FrostWarningsView = { nightOf, belowC: FROST_WARNING_BELOW_C, credit: FORECAST_CREDIT, warnings: [] };
  if (!siteIds.length) return view;
  view.warnings = rowsOf<{ site_id: number; name: string; lowest_c: number; coldest_at: string | Date | null }>(await db.execute(sql`
    SELECT f.site_id, s.name, f.lowest_c, f.coldest_at
    FROM frost_forecasts f JOIN sites s ON s.id = f.site_id AND s.client_id = f.client_id
    WHERE f.client_id = ${clientId} AND f.night_of = ${nightOf} AND f.warn = true
      AND f.site_id IN (${sql.join(siteIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY s.name, s.id
  `)).map((row) => ({
    siteId: Number(row.site_id), siteName: row.name, lowestC: Math.round(Number(row.lowest_c) * 10) / 10,
    coldestAt: row.coldest_at ? new Date(row.coldest_at).toISOString() : null,
  }));
  return view;
}
