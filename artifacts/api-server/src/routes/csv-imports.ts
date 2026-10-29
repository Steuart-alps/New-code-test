import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin, requireUserManager, getClientId, denyViewers, getActiveDepartmentId, isDepartmentLead } from "../middleware/requireAuth";
import { getEntitledServices, isEntitled, requireService, type ServiceKey } from "../lib/services";
import { filterName } from "../lib/contentFilter";
import { getEffectiveOptionList } from "../lib/formOptions";
import { siteVisibleSql } from "../lib/departmentSites";
import { getAccountToday } from "../lib/accountClock";
import { ReportReadingError, reportReadingConfigured, UnreadableReportError } from "../lib/reportReading";
import { readApplianceList, REGISTER_READING_MAX_BYTES, registerReadingMonthlyLimit } from "../lib/registerReading";
import { isListReadingKind, readList, SORTABLE_LIST_KINDS, sortList, type ListReadingKind, type SortableListKind } from "../lib/listReading";
import { AiUnavailableError, claimAiUse, getAiStatus, settleAiUse } from "../lib/aiAllowance";
import { categoryForTitle, contractorKey, isInHouseHeading, knownCheckFor, monthsBetween, parseRepeat } from "../lib/complianceCheckImport";
import { STARTER, STARTER_CHECK_NOTE } from "../lib/seedStarterContent";
import { CONTRACTOR_VISIT_TYPES, syncContractorVisitChecks } from "../lib/contractorVisits";
import { supersedeStaleReminderCycles } from "../lib/reminderCycles";
import { addMonthsToDay } from "../lib/taskSchedule";
import { logger } from "../lib/logger";
import {
  CSV_IMPORT_MAX_CELL_LENGTH,
  CSV_IMPORT_MAX_COLUMNS,
  CSV_IMPORT_MAX_ROWS,
  importTemplateCsv,
  mapImportRows,
  normaliseHeader,
  normaliseKey,
  parseImportDate,
  splitListCell,
  type CsvImportType,
  type MappedRow,
} from "../lib/csvImport";

// Register CSV imports. Like the staff-roster reconciliation, every request
// re-plans the whole file inside one transaction: a preview (the default)
// rolls nothing forward, and a commit writes only when every row is valid.
// Rows match existing records on a natural key (see CSV_IMPORT_KEYS) and blank
// cells never clear existing values.

const router = Router();
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Action = "create" | "update" | "skip" | "error";
interface PlannedRow { row: number; action: Action; label: string; reasons: string[]; write?: (tx: Tx) => Promise<void> }

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])
  .transform((value) => (value === null ? "" : String(value)))
  .pipe(z.string().max(CSV_IMPORT_MAX_CELL_LENGTH));
const importBody = z.object({
  headers: z.array(cell).min(1).max(CSV_IMPORT_MAX_COLUMNS),
  rows: z.array(z.array(cell).max(CSV_IMPORT_MAX_COLUMNS)).max(CSV_IMPORT_MAX_ROWS, `The maximum is ${CSV_IMPORT_MAX_ROWS} rows per import`),
  preview: z.boolean().default(true),
  // FireTrack call points: the site a row with a blank Site cell belongs to
  // (the one chosen on the page the file is uploaded from).
  siteId: z.number().int().positive().nullable().optional(),
});

// PATTrack lets staff add appliances, so department managers may import into
// their own department's sites; RoomTrack rooms, contractors and FireTrack call
// points are admin-only registers, exactly as their single-record routes are.
const requirePatImporter: RequestHandler = (req, res, next) => {
  const user = req.currentUser;
  if (user && (user.role === "client_admin" || user.role === "consultant" || isDepartmentLead(user))) return next();
  res.status(403).json({ error: "Manager access required" });
};

const rowsOf = (result: unknown) => ((result as { rows?: unknown[] }).rows ?? []) as any[];
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

interface SiteRef { id: number; name: string; visible: boolean }
async function siteResolver(tx: Tx, clientId: number, departmentId: number | null) {
  const visible = departmentId === null ? sql`TRUE` : siteVisibleSql(sql`s.id`, sql`s.department_id`, departmentId);
  const sites = rowsOf(await tx.execute(sql`SELECT s.id, s.name, ${visible} AS visible FROM sites s WHERE s.client_id = ${clientId}`)) as SiteRef[];
  return (name: string | null): { siteId: number | null; error?: string } => {
    if (!name) return { siteId: null };
    const matches = sites.filter((site) => normaliseKey(site.name) === normaliseKey(name));
    if (!matches.length) return { siteId: null, error: `Site "${name}" was not found in this business` };
    if (matches.length > 1) return { siteId: null, error: `More than one site is called "${name}"; rename one before importing` };
    const site = matches[0];
    if (!site.visible) {
      return { siteId: null, error: `Site "${name}" is outside your department` };
    }
    return { siteId: Number(site.id) };
  };
}
async function departmentSiteCheck(tx: Tx, clientId: number, departmentId: number | null) {
  if (departmentId === null) return () => true;
  const blocked = new Set(rowsOf(await tx.execute(sql`
    SELECT s.id FROM sites s WHERE s.client_id = ${clientId} AND NOT ${siteVisibleSql(sql`s.id`, sql`s.department_id`, departmentId)}
  `)).map((row) => Number(row.id)));
  return (siteId: number | null) => siteId === null || !blocked.has(siteId);
}

/** Flag rows that repeat an earlier row's natural key within the same file. */
function duplicateGuard() {
  const seen = new Map<string, number>();
  return (key: string, row: number): string | null => {
    const first = seen.get(key);
    if (first !== undefined) return `Duplicate of row ${first} in this file`;
    seen.set(key, row);
    return null;
  };
}

function changedFields(pairs: Array<[label: string, current: unknown, next: unknown]>): string[] {
  return pairs.filter(([, current, next]) => next !== undefined && !same(current, next)).map(([label]) => label);
}

async function planPatAppliances(tx: Tx, clientId: number, departmentId: number | null, rows: MappedRow[]): Promise<PlannedRow[]> {
  const resolveSite = await siteResolver(tx, clientId, departmentId);
  const siteAllowed = await departmentSiteCheck(tx, clientId, departmentId);
  const existing = rowsOf(await tx.execute(sql`
    SELECT id, site_id, name, appliance_type, location, asset_tag, description, active
    FROM pat_appliances WHERE client_id = ${clientId} ORDER BY id FOR UPDATE
  `));
  const duplicate = duplicateGuard();
  return rows.map((input): PlannedRow => {
    const v = input.values;
    const label = [v.name, v.assetTag].filter(Boolean).join(" · ") || `Row ${input.row}`;
    const errors = [...input.errors];
    const site = resolveSite(v.site);
    if (site.error) errors.push(site.error);
    if (errors.length) return { row: input.row, action: "error", label, reasons: errors };

    const tag = normaliseKey(v.assetTag);
    const key = tag ? `tag:${tag}` : `nsl:${normaliseKey(v.name)}|${site.siteId ?? ""}|${normaliseKey(v.location)}`;
    const repeated = duplicate(key, input.row);
    if (repeated) return { row: input.row, action: "error", label, reasons: [repeated] };
    const matches = tag
      ? existing.filter((item) => normaliseKey(item.asset_tag) === tag)
      : existing.filter((item) => normaliseKey(item.name) === normaliseKey(v.name)
        && Number(item.site_id ?? 0) === Number(site.siteId ?? 0) && normaliseKey(item.location) === normaliseKey(v.location));
    if (matches.length > 1) {
      return { row: input.row, action: "error", label, reasons: [tag ? `Asset tag "${v.assetTag}" is already used by more than one appliance` : "Matches more than one existing appliance; add asset tags to tell them apart"] };
    }
    const match = matches[0];
    if (!match) {
      return {
        row: input.row, action: "create", label, reasons: [],
        write: async (t) => { await t.execute(sql`
          INSERT INTO pat_appliances (client_id, site_id, name, appliance_type, location, asset_tag, description, active)
          VALUES (${clientId}, ${site.siteId}, ${v.name}, ${v.applianceType ?? "Other"}, ${v.location}, ${v.assetTag}, ${v.description}, true)
        `); },
      };
    }
    if (!siteAllowed(match.site_id === null ? null : Number(match.site_id))) {
      return { row: input.row, action: "error", label, reasons: ["Matches an appliance at a site outside your department"] };
    }
    if (!match.active) return { row: input.row, action: "skip", label, reasons: ["Matches a retired appliance; reinstate it from the register instead"] };
    const next = {
      siteId: v.site ? site.siteId : undefined,
      name: v.name ?? undefined,
      applianceType: v.applianceType ?? undefined,
      location: v.location ?? undefined,
      description: v.description ?? undefined,
    };
    const changes = changedFields([
      ["name", match.name, next.name], ["appliance type", match.appliance_type, next.applianceType],
      ["site", match.site_id === null ? null : Number(match.site_id), next.siteId], ["location", match.location, next.location],
      ["notes", match.description, next.description],
    ]);
    if (!changes.length) return { row: input.row, action: "skip", label, reasons: ["Already in the register with the same details"] };
    return {
      row: input.row, action: "update", label, reasons: [`Updates ${changes.join(", ")}`],
      write: async (t) => { await t.execute(sql`
        UPDATE pat_appliances SET
          site_id = ${next.siteId === undefined ? match.site_id : next.siteId},
          name = ${next.name ?? match.name},
          appliance_type = ${next.applianceType ?? match.appliance_type},
          location = ${next.location ?? match.location},
          description = ${next.description ?? match.description},
          updated_at = now()
        WHERE id = ${match.id} AND client_id = ${clientId}
      `); },
    };
  });
}

async function planRooms(tx: Tx, clientId: number, departmentId: number | null, userId: number, rows: MappedRow[]): Promise<PlannedRow[]> {
  const resolveSite = await siteResolver(tx, clientId, departmentId);
  const existing = rowsOf(await tx.execute(sql`
    SELECT id, site_id, room_number, name, floor, notes, active
    FROM room_track_rooms WHERE client_id = ${clientId} ORDER BY id FOR UPDATE
  `));
  const duplicate = duplicateGuard();
  return rows.map((input): PlannedRow => {
    const v = input.values;
    const label = [v.roomNumber, v.name].filter(Boolean).join(" · ") || `Row ${input.row}`;
    const errors = [...input.errors];
    const site = resolveSite(v.site);
    if (site.error) errors.push(site.error);
    if (errors.length) return { row: input.row, action: "error", label, reasons: errors };

    const repeated = duplicate(`${site.siteId ?? ""}|${normaliseKey(v.roomNumber)}`, input.row);
    if (repeated) return { row: input.row, action: "error", label, reasons: [repeated] };
    const matches = existing.filter((item) => Number(item.site_id ?? 0) === Number(site.siteId ?? 0)
      && normaliseKey(item.room_number) === normaliseKey(v.roomNumber));
    if (matches.length > 1) return { row: input.row, action: "error", label, reasons: ["Matches more than one existing room at this site"] };
    const match = matches[0];
    if (!match) {
      return {
        row: input.row, action: "create", label, reasons: [],
        write: async (t) => { await t.execute(sql`
          INSERT INTO room_track_rooms (client_id, site_id, room_number, name, floor, notes, active, created_by, updated_by)
          VALUES (${clientId}, ${site.siteId}, ${v.roomNumber}, ${v.name}, ${v.floor}, ${v.notes}, true, ${userId}, ${userId})
        `); },
      };
    }
    if (!match.active) return { row: input.row, action: "skip", label, reasons: ["Matches an archived room; restore it in RoomTrack instead"] };
    const changes = changedFields([
      ["room name", match.name, v.name ?? undefined], ["floor", match.floor, v.floor ?? undefined], ["notes", match.notes, v.notes ?? undefined],
    ]);
    if (!changes.length) return { row: input.row, action: "skip", label, reasons: ["Already in RoomTrack with the same details"] };
    return {
      row: input.row, action: "update", label, reasons: [`Updates ${changes.join(", ")}`],
      write: async (t) => { await t.execute(sql`
        UPDATE room_track_rooms SET
          name = ${v.name ?? match.name}, floor = ${v.floor ?? match.floor}, notes = ${v.notes ?? match.notes},
          updated_by = ${userId}, updated_at = now()
        WHERE id = ${match.id} AND client_id = ${clientId}
      `); },
    };
  });
}

async function planContractors(tx: Tx, clientId: number, rows: MappedRow[]): Promise<PlannedRow[]> {
  const allowedTrades = await getEffectiveOptionList(clientId, "fixtrack_trades");
  const existing = rowsOf(await tx.execute(sql`
    SELECT id, name, company, email, phone, address, notes, trades, gas_safe_number,
           to_char(public_liability_expiry, 'YYYY-MM-DD') AS public_liability_expiry
    FROM contractors WHERE client_id = ${clientId} ORDER BY id FOR UPDATE
  `));
  const duplicate = duplicateGuard();
  return rows.map((input): PlannedRow => {
    const v = input.values;
    const label = [v.name, v.company].filter(Boolean).join(" · ") || `Row ${input.row}`;
    const errors = [...input.errors];
    for (const [field, value] of [["Contact name", v.name], ["Company", v.company], ["Gas Safe number", v.gasSafeNumber]] as const) {
      if (!value) continue;
      const check = filterName(value);
      if (!check.ok) errors.push(`${field}: ${check.message}`);
    }
    const email = normaliseKey(v.email);
    const matches = email ? existing.filter((item) => normaliseKey(item.email) === email) : [];
    const currentTrades: string[] = Array.isArray(matches[0]?.trades) ? matches[0].trades : [];
    let trades: string[] | undefined;
    if (v.trades) {
      trades = [];
      for (const trade of splitListCell(v.trades)) {
        // Options are stored as keys ("gas_kitchen"); accept "Gas kitchen" too.
        const known = [...allowedTrades, ...currentTrades].find((option) => normaliseHeader(option) === normaliseHeader(trade));
        if (known) { if (!trades.includes(known)) trades.push(known); }
        else errors.push(`Trade "${trade}" is not one of this business's trade options`);
      }
      if (trades.length > 20) errors.push("A contractor can have at most 20 trades");
    }
    if (errors.length) return { row: input.row, action: "error", label, reasons: errors };
    const repeated = duplicate(email, input.row);
    if (repeated) return { row: input.row, action: "error", label, reasons: [repeated] };
    if (matches.length > 1) return { row: input.row, action: "error", label, reasons: [`More than one contractor already uses ${v.email}`] };
    const match = matches[0];
    if (!match) {
      return {
        row: input.row, action: "create", label, reasons: [],
        write: async (t) => { await t.execute(sql`
          INSERT INTO contractors (client_id, name, company, email, phone, address, notes, trades, gas_safe_number, public_liability_expiry, updated_at)
          VALUES (${clientId}, ${v.name}, ${v.company}, ${v.email}, ${v.phone}, ${v.address}, ${v.notes},
                  ${JSON.stringify(trades ?? [])}::jsonb, ${v.gasSafeNumber}, ${v.publicLiabilityExpiry}::date, now())
        `); },
      };
    }
    const tradesChanged = trades !== undefined && JSON.stringify(trades) !== JSON.stringify(currentTrades);
    const changes = changedFields([
      ["contact name", match.name, v.name ?? undefined], ["company", match.company, v.company ?? undefined],
      ["phone", match.phone, v.phone ?? undefined], ["address", match.address, v.address ?? undefined],
      ["notes", match.notes, v.notes ?? undefined], ["Gas Safe number", match.gas_safe_number, v.gasSafeNumber ?? undefined],
      ["public liability expiry", match.public_liability_expiry, v.publicLiabilityExpiry ?? undefined],
    ]);
    if (tradesChanged) changes.push("trades");
    if (!changes.length) return { row: input.row, action: "skip", label, reasons: ["Already a contractor with the same details"] };
    return {
      row: input.row, action: "update", label, reasons: [`Updates ${changes.join(", ")}`],
      write: async (t) => { await t.execute(sql`
        UPDATE contractors SET
          name = ${v.name ?? match.name}, company = ${v.company ?? match.company}, phone = ${v.phone ?? match.phone},
          address = ${v.address ?? match.address}, notes = ${v.notes ?? match.notes},
          gas_safe_number = ${v.gasSafeNumber ?? match.gas_safe_number},
          public_liability_expiry = COALESCE(${v.publicLiabilityExpiry}::date, public_liability_expiry),
          trades = ${JSON.stringify(trades ?? currentTrades)}::jsonb,
          updated_at = now()
        WHERE id = ${match.id} AND client_id = ${clientId}
      `); },
    };
  });
}

async function planFireCallPoints(
  tx: Tx, clientId: number, departmentId: number | null, userId: number, defaultSiteId: number | null | undefined, rows: MappedRow[],
): Promise<PlannedRow[]> {
  const resolveSite = await siteResolver(tx, clientId, departmentId);
  const siteRows = rowsOf(await tx.execute(sql`SELECT id FROM sites WHERE client_id = ${clientId}`));
  const siteAllowed = await departmentSiteCheck(tx, clientId, departmentId);
  // A blank Site cell means the site chosen on the page, or the only site.
  let blankSite: { siteId: number | null; error?: string };
  if (defaultSiteId != null) {
    blankSite = siteRows.some((row) => Number(row.id) === defaultSiteId) && siteAllowed(defaultSiteId)
      ? { siteId: defaultSiteId } : { siteId: null, error: "The chosen site is not one of this business's sites" };
  } else if (siteRows.length > 1) {
    blankSite = { siteId: null, error: "Site is required: this business has more than one site" };
  } else {
    const onlySite = siteRows.length ? Number(siteRows[0].id) : null;
    blankSite = siteAllowed(onlySite) ? { siteId: onlySite } : { siteId: null, error: "The site is outside your department" };
  }
  const existing = rowsOf(await tx.execute(sql`
    SELECT id, site_id, name, location, archived_at IS NOT NULL AS archived
    FROM fire_call_points WHERE client_id = ${clientId} ORDER BY id FOR UPDATE
  `));
  const duplicate = duplicateGuard();
  return rows.map((input): PlannedRow => {
    const v = input.values;
    const label = [v.name, v.location].filter(Boolean).join(" · ") || `Row ${input.row}`;
    const errors = [...input.errors];
    const site = v.site ? resolveSite(v.site) : blankSite;
    if (site.error) errors.push(site.error);
    if (errors.length) return { row: input.row, action: "error", label, reasons: errors };

    const repeated = duplicate(`${site.siteId ?? ""}|${normaliseKey(v.name)}`, input.row);
    if (repeated) return { row: input.row, action: "error", label, reasons: [repeated] };
    const matches = existing.filter((item) => Number(item.site_id ?? 0) === Number(site.siteId ?? 0)
      && normaliseKey(item.name) === normaliseKey(v.name));
    const match = matches.find((item) => !item.archived);
    if (!match) {
      if (matches.length) return { row: input.row, action: "skip", label, reasons: ["Matches an archived call point; restore it under Template, Call points instead"] };
      return {
        row: input.row, action: "create", label, reasons: [],
        // Each new call point joins the end of its site's rotation, in file order.
        write: async (t) => { await t.execute(sql`
          INSERT INTO fire_call_points (client_id, site_id, name, location, sort_order, created_by)
          VALUES (${clientId}, ${site.siteId}, ${v.name}, ${v.location},
            (SELECT coalesce(max(sort_order), 0) + 1 FROM fire_call_points
             WHERE client_id = ${clientId} AND site_id IS NOT DISTINCT FROM ${site.siteId}::integer),
            ${userId})
        `); },
      };
    }
    const changes = changedFields([["location", match.location, v.location ?? undefined]]);
    if (!changes.length) return { row: input.row, action: "skip", label, reasons: ["Already listed with the same details"] };
    return {
      row: input.row, action: "update", label, reasons: [`Updates ${changes.join(", ")}`],
      write: async (t) => { await t.execute(sql`
        UPDATE fire_call_points SET location = ${v.location ?? match.location}, updated_at = now()
        WHERE id = ${match.id} AND client_id = ${clientId}
      `); },
    };
  });
}

const ukDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Description, priority and lead time of ComplyTrack's own check with this title. */
function knownCheckDetails(title: string): { description: string | null; priority: "low" | "medium" | "high" | "critical"; leadTimeDays: number; categoryColor: string | null } {
  const key = normaliseKey(title);
  for (const category of STARTER) {
    const check = category.checks.find((candidate) => normaliseKey(candidate.title) === key);
    if (check) return { description: check.description, priority: check.priority, leadTimeDays: check.leadTimeDays ?? 30, categoryColor: category.color };
  }
  const visit = CONTRACTOR_VISIT_TYPES.find((type) => normaliseKey(type.title) === key);
  return { description: visit?.description ?? null, priority: "high", leadTimeDays: 30, categoryColor: null };
}

/**
 * A business's compliance checklist (lib/complianceCheckImport.ts). Each line
 * is matched to ComplyTrack's own check where there is one, then to a check
 * the business already has with that title at the site (or for the whole
 * business). A match gets the file's repeat, a later last-done date (with the
 * next due date) and a contractor when it has none; nothing newer in
 * ComplyTrack is overwritten. Headings, in-house routines and weekly checks
 * are skipped, with the reason. A contractor not yet on the Contractors page
 * is added when the line gives an email address (every contractor needs one
 * for reminders); otherwise their name and phone go in the check's notes.
 */
async function planComplianceChecks(
  tx: Tx, clientId: number, departmentId: number | null, userId: number, defaultSiteId: number | null | undefined, rows: MappedRow[],
): Promise<PlannedRow[]> {
  const services = await getEntitledServices(clientId);
  const today = await getAccountToday(clientId);
  const resolveSite = await siteResolver(tx, clientId, departmentId);
  const siteAllowed = await departmentSiteCheck(tx, clientId, departmentId);
  const siteRows = rowsOf(await tx.execute(sql`SELECT id FROM sites WHERE client_id = ${clientId} ORDER BY id`));
  // A blank Site cell: the site chosen where the file was uploaded, else the
  // only site, else the whole business.
  let blankSite: { siteId: number | null; error?: string };
  if (defaultSiteId != null) {
    blankSite = siteRows.some((row) => Number(row.id) === defaultSiteId) && siteAllowed(defaultSiteId)
      ? { siteId: defaultSiteId } : { siteId: null, error: "The chosen site is not one of this business's sites" };
  } else {
    blankSite = { siteId: siteRows.length === 1 ? Number(siteRows[0].id) : null };
  }
  const existing = rowsOf(await tx.execute(sql`
    SELECT id, title, site_id, contractor_id, frequency_months, status, notes,
           to_char(due_date, 'YYYY-MM-DD') AS due_day, to_char(completed_at, 'YYYY-MM-DD') AS completed_day
    FROM compliance_items WHERE client_id = ${clientId} ORDER BY id FOR UPDATE
  `));
  const contractors = rowsOf(await tx.execute(sql`SELECT id, name, company, email FROM contractors WHERE client_id = ${clientId} ORDER BY id`));
  const categories = rowsOf(await tx.execute(sql`SELECT id, name FROM categories WHERE client_id = ${clientId} ORDER BY id`));
  const categoryIds = new Map<string, number>(categories.map((row) => [normaliseKey(row.name), Number(row.id)]));
  // Contractors added by this file, by email, so several lines share one.
  const addedContractors = new Map<string, number>();
  const plannedContractors = new Set<string>();
  const duplicate = duplicateGuard();
  // A business-wide check taken by one site's line; another site's line gets its own.
  const claimed = new Set<number>();
  let inHouse = false;

  const categoryIdFor = async (t: Tx, name: string, color: string | null) => {
    const key = normaliseKey(name);
    const known = categoryIds.get(key);
    if (known !== undefined) return known;
    const inserted = rowsOf(await t.execute(sql`
      INSERT INTO categories (client_id, name, color) VALUES (${clientId}, ${name}, ${color ?? "#6366f1"}) RETURNING id
    `));
    const id = Number(inserted[0].id);
    categoryIds.set(key, id);
    return id;
  };
  type ContractorRef = { id: number } | { email: string; name: string; phone: string | null };
  const contractorIdFor = async (t: Tx, ref: ContractorRef) => {
    if ("id" in ref) return ref.id;
    const known = addedContractors.get(ref.email);
    if (known !== undefined) return known;
    const inserted = rowsOf(await t.execute(sql`
      INSERT INTO contractors (client_id, name, company, email, phone, trades, updated_at)
      VALUES (${clientId}, ${ref.name}, ${ref.name}, ${ref.email}, ${ref.phone}, '[]'::jsonb, now()) RETURNING id
    `));
    const id = Number(inserted[0].id);
    addedContractors.set(ref.email, id);
    return id;
  };
  const audit = (t: Tx, entityId: number, action: "created" | "updated", before: unknown, after: unknown, row: number) => t.execute(sql`
    INSERT INTO audit_events (client_id, actor_id, entity_type, entity_id, action, before, after, metadata)
    VALUES (${clientId}, ${userId}, 'compliance_item', ${entityId}, ${action}, ${before === null ? null : JSON.stringify(before)}::jsonb,
            ${JSON.stringify(after)}::jsonb, ${JSON.stringify({ spreadsheetImport: { row } })}::jsonb)
  `);

  return rows.map((input): PlannedRow => {
    const v = input.values;
    const title = v.title ?? "";
    const otherCells = [v.repeat, v.lastDone, v.dueDate, v.contractor, v.phone, v.email, v.site, v.category, v.notes];
    if (title && !input.errors.length && otherCells.every((value) => !value)) {
      inHouse = isInHouseHeading(title);
      return { row: input.row, action: "skip", label: title, reasons: ["A heading or note, not a check"] };
    }
    if (inHouse) {
      return { row: input.row, action: "skip", label: title || `Row ${input.row}`, reasons: ["An in-house routine (under the In-house heading): it is recorded on its track, such as FireTrack or Water Safety, not as a contractor check"] };
    }
    const errors = [...input.errors];
    const reasons: string[] = [];
    for (const [field, value] of [["Check", v.title], ["Contractor", v.contractor], ["Notes", v.notes]] as const) {
      if (!value) continue;
      const check = filterName(value);
      if (!check.ok) errors.push(`${field}: ${check.message}`);
    }
    const repeat = parseRepeat(v.repeat);
    if (repeat.kind === "under_a_month") {
      return { row: input.row, action: "skip", label: title, reasons: [`Repeats "${v.repeat}": daily and weekly checks are kept on the track's checklists, not as compliance checks`] };
    }
    const lastDone = v.lastDone ? parseImportDate(v.lastDone) : null;
    const lastDoneText = v.lastDone && !lastDone ? v.lastDone : null;
    if (lastDone && lastDone > today) errors.push(`Last done ${ukDay(lastDone)} is in the future`);
    const known = knownCheckFor(title, (service) => isEntitled(services, service as ServiceKey));
    const months = repeat.kind === "months" ? repeat.months : lastDone && v.dueDate ? monthsBetween(lastDone, v.dueDate) : null;
    if (known?.inHouseBelowMonths && months && months < known.inHouseBelowMonths) {
      return { row: input.row, action: "skip", label: title, reasons: [`${known.inHouseHint}; this line repeats every ${months === 1 ? "month" : `${months} months`}`] };
    }
    if (!months && v.repeat) reasons.push(`Repeat "${v.repeat}" was not understood: set it on the check`);
    if (repeat.kind !== "months" && months) reasons.push(`Repeat every ${months} months, from the dates`);
    const dueDay = v.dueDate ?? (lastDone && months ? addMonthsToDay(lastDone, months) : null);
    if (dueDay && lastDone && dueDay <= lastDone) errors.push("Next due must be after Last done");
    const site = v.site ? resolveSite(v.site) : blankSite;
    if (site.error) errors.push(site.error);
    const finalTitle = known?.title ?? title;
    const label = known && normaliseKey(known.title) !== normaliseKey(title) ? `${title} → ${known.title}` : title;

    // The contractor: an existing one by email or name, or one this file adds.
    let contractor: ContractorRef | null = null;
    let contractorNote: string | null = null;
    if (v.contractor || v.email) {
      const wanted = contractorKey(v.contractor);
      const matches = v.email
        ? contractors.filter((row) => normaliseKey(row.email) === v.email)
        : contractors.filter((row) => wanted && (contractorKey(row.company) === wanted || contractorKey(row.name) === wanted));
      if (matches.length === 1) contractor = { id: Number(matches[0].id) };
      else if (matches.length > 1) reasons.push(`More than one contractor is called "${v.contractor}": choose one on the check`);
      else if (v.email) {
        contractor = { email: v.email, name: v.contractor ?? v.email, phone: v.phone };
        if (!plannedContractors.has(v.email)) reasons.push(`Adds ${v.contractor ?? v.email} to your contractors`);
        plannedContractors.add(v.email);
      } else {
        contractorNote = `Contractor: ${v.contractor}${v.phone ? `, ${v.phone}` : ""}`;
        reasons.push(`${v.contractor} is not one of your contractors yet: put their email address in the file (or add them on the Contractors page) and upload it again to link them`);
      }
    }
    if (errors.length) return { row: input.row, action: "error", label, reasons: errors };
    const repeated = duplicate(`${site.siteId ?? ""}|${normaliseKey(finalTitle)}`, input.row);
    if (repeated) return { row: input.row, action: "error", label, reasons: [repeated] };

    const titles = new Set([finalTitle, title, ...(known?.alsoKnownAs ?? [])].map(normaliseKey));
    const candidates = existing.filter((item) => titles.has(normaliseKey(item.title)));
    const atSite = candidates.filter((item) => Number(item.site_id ?? 0) === Number(site.siteId ?? 0));
    const pick = atSite.length || site.siteId === null ? atSite : candidates.filter((item) => item.site_id === null && !claimed.has(Number(item.id)));
    if (pick.length > 1) {
      return { row: input.row, action: "error", label, reasons: [`Matches ${pick.length} checks already called "${pick[0].title}"; rename or delete the extra ones first`] };
    }
    const match = pick[0];
    if (match) claimed.add(Number(match.id));
    const renamedNote = known && normaliseKey(known.title) !== normaliseKey(title) ? `Your spreadsheet called it "${title}".` : null;
    const lastDoneNote = lastDone ? `Last done ${ukDay(lastDone)}.` : null;

    if (!match) {
      const details = knownCheckDetails(finalTitle);
      const categoryName = v.category ?? known?.category ?? categoryForTitle(title);
      const notes = [
        "Imported from your compliance spreadsheet.",
        renamedNote, lastDoneNote, lastDoneText, contractorNote, v.notes,
      ].filter(Boolean).join("\n");
      reasons.unshift(dueDay ? `Next due ${ukDay(dueDay)}` : "No date in the file: set the next due date on the check");
      return {
        row: input.row, action: "create", label, reasons,
        write: async (t) => {
          const categoryId = await categoryIdFor(t, categoryName, details.categoryColor);
          const contractorId = contractor ? await contractorIdFor(t, contractor) : null;
          const created = rowsOf(await t.execute(sql`
            INSERT INTO compliance_items (client_id, site_id, category_id, contractor_id, title, description, status, priority,
                                          lead_time_days, frequency_months, due_date, completed_at, notes, updated_at)
            VALUES (${clientId}, ${site.siteId}, ${categoryId}, ${contractorId}, ${finalTitle}, ${details.description}, 'pending',
                    ${details.priority}, ${details.leadTimeDays}, ${months}, ${dueDay}::date, ${lastDone}::date, ${notes}, now())
            RETURNING *
          `))[0];
          await audit(t, Number(created.id), "created", null, created, input.row);
        },
      };
    }

    const changes: string[] = [];
    // A business-wide check (a starter check) becomes this site's, as in the setup wizard.
    const moveToSite = match.site_id === null && site.siteId !== null;
    if (moveToSite) changes.push("site");
    const takeDates = !!lastDone && (!match.completed_day || lastDone > match.completed_day);
    if (lastDone && !takeDates && lastDone < match.completed_day) reasons.push(`ComplyTrack already has a later completion (${ukDay(match.completed_day)}), so its dates are kept`);
    const nextDue = takeDates ? dueDay ?? undefined : !lastDone && dueDay && !match.due_day && !match.completed_day ? dueDay : undefined;
    if (months && months !== (match.frequency_months == null ? null : Number(match.frequency_months))) changes.push("repeat");
    if (takeDates) changes.push("last done");
    if (nextDue !== undefined && nextDue !== match.due_day) changes.push("next due");
    const linkContractor = contractor && match.contractor_id == null;
    if (linkContractor) changes.push("contractor");
    else if (contractor && "id" in contractor && Number(match.contractor_id) !== contractor.id) reasons.push("Keeps the contractor already chosen on the check");
    const replaceStarterNote = match.notes === STARTER_CHECK_NOTE;
    if (!changes.length) {
      return { row: input.row, action: "skip", label: `${title} → ${match.title}`, reasons: ["Already in ComplyTrack with the same details", ...reasons] };
    }
    reasons.unshift(`Updates ${changes.join(", ")}${nextDue ? `; next due ${ukDay(nextDue)}` : ""}`);
    return {
      row: input.row, action: "update", label: label === title && normaliseKey(match.title) !== normaliseKey(title) ? `${title} → ${match.title}` : label, reasons,
      write: async (t) => {
        const contractorId = linkContractor ? await contractorIdFor(t, contractor!) : null;
        const before = rowsOf(await t.execute(sql`SELECT * FROM compliance_items WHERE id = ${match.id} AND client_id = ${clientId}`))[0];
        const dueChanged = nextDue !== undefined && nextDue !== match.due_day;
        const importedNote = ["Imported from your compliance spreadsheet.", renamedNote, lastDoneNote, lastDoneText, contractorNote, v.notes].filter(Boolean).join("\n");
        const after = rowsOf(await t.execute(sql`
          UPDATE compliance_items SET
            site_id = COALESCE(site_id, ${moveToSite ? site.siteId : null}::integer),
            frequency_months = COALESCE(${months}::integer, frequency_months),
            completed_at = CASE WHEN ${takeDates} THEN ${lastDone}::timestamp ELSE completed_at END,
            due_date = CASE WHEN ${dueChanged} THEN ${nextDue ?? null}::timestamp ELSE due_date END,
            status = CASE WHEN ${dueChanged || takeDates} AND status <> 'in_progress' THEN 'pending' ELSE status END,
            notification_sent_at = CASE WHEN ${dueChanged} THEN NULL ELSE notification_sent_at END,
            contractor_id = COALESCE(contractor_id, ${contractorId}::integer),
            notes = CASE WHEN ${replaceStarterNote} THEN ${importedNote} ELSE notes END,
            updated_at = now()
          WHERE id = ${match.id} AND client_id = ${clientId}
          RETURNING *
        `))[0];
        if (dueChanged) await supersedeStaleReminderCycles(t, clientId, Number(match.id));
        await audit(t, Number(match.id), "updated", before, after, input.row);
      },
    };
  });
}

function handleImport(type: CsvImportType): RequestHandler {
  return async (req: Request, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const parsed = importBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid import data" });
    }
    const mapped = mapImportRows(type, { headers: parsed.data.headers, rows: parsed.data.rows });
    if (mapped.fileErrors.length) {
      return res.status(400).json({ error: mapped.fileErrors[0], fileErrors: mapped.fileErrors, ignoredHeaders: mapped.ignoredHeaders });
    }
    if (!mapped.rows.length) return res.status(400).json({ error: "The file has no rows to import" });
    const departmentId = getActiveDepartmentId(req);
    const { preview } = parsed.data;

    const outcome = await db.transaction(async (tx) => {
      // One import per register and business at a time, so two uploads cannot
      // both create the same asset tag, room or contractor.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`csv-import:${type}`}), ${clientId})`);
      const planned = type === "pat-appliances"
        ? await planPatAppliances(tx, clientId, departmentId, mapped.rows)
        : type === "room-track-rooms"
          ? await planRooms(tx, clientId, departmentId, req.currentUser!.id, mapped.rows)
          : type === "fire-call-points"
            ? await planFireCallPoints(tx, clientId, departmentId, req.currentUser!.id, parsed.data.siteId, mapped.rows)
            : type === "compliance-checks"
              ? await planComplianceChecks(tx, clientId, departmentId, req.currentUser!.id, parsed.data.siteId, mapped.rows)
              : await planContractors(tx, clientId, mapped.rows);
      const summary = {
        total: planned.length,
        create: planned.filter((row) => row.action === "create").length,
        update: planned.filter((row) => row.action === "update").length,
        skip: planned.filter((row) => row.action === "skip").length,
        error: planned.filter((row) => row.action === "error").length,
      };
      const committed = !preview && summary.error === 0;
      if (committed) for (const row of planned) await row.write?.(tx);
      return { summary, committed, rows: planned.map(({ row, action, label, reasons }) => ({ row, action, label, reasons })) };
    });

    // Checks the tracks keep (PAT testing, sprayer tests) take the track's due date.
    if (type === "compliance-checks" && outcome.committed) {
      await syncContractorVisitChecks(clientId).catch((err) => logger.warn({ err, clientId }, "Track due dates not applied after a compliance check import"));
    }
    const body = { preview, ignoredHeaders: mapped.ignoredHeaders, ...outcome };
    if (!preview && !outcome.committed) {
      return res.status(409).json({ ...body, error: "Nothing was imported: fix the rows marked as errors and upload the file again" });
    }
    res.json(body);
  };
}

function sendTemplate(type: CsvImportType, filename: string): RequestHandler {
  return (_req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(importTemplateCsv(type));
  };
}

router.get("/imports/pat-appliances/template", requireAuth, requirePatImporter, requireService("pattrack"), sendTemplate("pat-appliances", "pattrack-appliances-template.csv"));
router.post("/imports/pat-appliances", requireAuth, denyViewers, requirePatImporter, requireService("pattrack"), handleImport("pat-appliances"));

// ── Reading a photo, scan, PDF or Word list into PAT register rows ─────────
// Claude reads the file (lib/registerReading.ts) and the rows come back to the
// browser, which sends them through the import preview above like a
// spreadsheet. The file itself is not stored. Each business may have
// REGISTER_READING_MONTHLY_LIMIT lists read a month, counted in app_settings
// as "YYYY-MM:count" so a new month starts again at nought.
const REGISTER_READS_SETTING = "patRegisterReads";
/**
 * Held against the AI allowance while a list is read; a few photographed pages
 * cost about this (PAT registers on Claude Sonnet 5.5, other lists on Claude
 * Haiku 5.5, lib/aiModels.ts). The real cost replaces it once Claude answers.
 */
const REGISTER_READING_ESTIMATE_PENCE = 15;
const LIST_READING_ESTIMATE_PENCE = 2;
/** Sorting a file only asks which list it is, so it costs far less than reading it. */
const LIST_SORTING_ESTIMATE_PENCE = 1;
class RegisterReadLimitError extends Error {}

async function importableSites(clientId: number, departmentId: number | null) {
  const visible = departmentId === null ? sql`TRUE` : siteVisibleSql(sql`s.id`, sql`s.department_id`, departmentId);
  return rowsOf(await db.execute(sql`SELECT s.id, s.name FROM sites s WHERE s.client_id = ${clientId} AND ${visible} ORDER BY s.name, s.id`))
    .map((row) => ({ id: Number(row.id), name: String(row.name) }));
}

async function registerReadsThisMonth(clientId: number, month: string) {
  const [row] = rowsOf(await db.execute(sql`SELECT value FROM app_settings WHERE client_id = ${clientId} AND key = ${REGISTER_READS_SETTING}`));
  const [storedMonth, count] = String(row?.value ?? "").split(":");
  return storedMonth === month ? Number(count) || 0 : 0;
}

/** Count one reading for this month, unless the limit is reached. False when it is. */
async function claimRegisterRead(clientId: number, month: string, limit: number) {
  const underLimit = limit > 0
    ? sql`WHERE split_part(app_settings.value, ':', 1) <> ${month} OR coalesce(nullif(split_part(app_settings.value, ':', 2), ''), '0')::int < ${limit}`
    : sql``;
  const claimed = rowsOf(await db.execute(sql`
    INSERT INTO app_settings (client_id, key, value, updated_at) VALUES (${clientId}, ${REGISTER_READS_SETTING}, ${`${month}:1`}, now())
    ON CONFLICT (client_id, key) DO UPDATE SET
      value = CASE WHEN split_part(app_settings.value, ':', 1) = ${month}
        THEN ${month} || ':' || (coalesce(nullif(split_part(app_settings.value, ':', 2), ''), '0')::int + 1)
        ELSE ${`${month}:1`} END,
      updated_at = now()
    ${underLimit}
    RETURNING value
  `));
  return claimed.length > 0;
}

const registerReadBody = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(200),
  // Base64 of the file; the browser shrinks photos before sending them.
  data: z.string().min(1).max(Math.ceil(REGISTER_READING_MAX_BYTES / 3) * 4 + 4),
  siteId: z.number().int().positive().nullable().optional(),
}).strict();

router.get("/imports/pat-appliances/reading", requireAuth, requirePatImporter, requireService("pattrack"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const month = (await getAccountToday(clientId)).slice(0, 7);
  const [sites, used, ai] = await Promise.all([
    importableSites(clientId, getActiveDepartmentId(req)), registerReadsThisMonth(clientId, month), getAiStatus(clientId),
  ]);
  res.json({ available: reportReadingConfigured(), monthlyLimit: registerReadingMonthlyLimit(), usedThisMonth: used, ai, sites });
});

router.post("/imports/pat-appliances/read", requireAuth, denyViewers, requirePatImporter, requireService("pattrack"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!reportReadingConfigured()) {
    return res.status(503).json({ error: "Reading photos and documents is not switched on yet. Upload a spreadsheet instead.", code: "REGISTER_READING_UNAVAILABLE" });
  }
  const parsed = registerReadBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a photo, PDF or Word file of your list (8 MB at most)" });
  const departmentId = getActiveDepartmentId(req);
  const sites = await importableSites(clientId, departmentId);
  const siteId = parsed.data.siteId ?? null;
  if (siteId !== null && !sites.some((site) => site.id === siteId)) return res.status(400).json({ error: "Choose one of your sites" });

  const bytes = Buffer.from(parsed.data.data, "base64");
  const month = (await getAccountToday(clientId)).slice(0, 7);
  const limit = registerReadingMonthlyLimit();
  let aiUseId: number | null = null;
  try {
    // A file Claude cannot read is turned away before it counts towards the
    // limit or the AI allowance (lib/aiAllowance.ts).
    const result = await readApplianceList({ bytes, mimeType: parsed.data.mimeType, fileName: parsed.data.fileName, sites, siteId }, async () => {
      aiUseId = await claimAiUse({
        clientId, userId: req.currentUser?.id ?? null, feature: "register_reading",
        estimatePence: REGISTER_READING_ESTIMATE_PENCE, instead: "Upload a spreadsheet instead.",
      });
      if (!await claimRegisterRead(clientId, month, limit)) {
        throw new RegisterReadLimitError(`This business has had ${limit} lists read this month, the most allowed. Upload a spreadsheet instead, or ask ALPS.`);
      }
    });
    if (aiUseId !== null) await settleAiUse(aiUseId, result.usage, true);
    req.log.info({ clientId, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, rows: result.rows.length }, "PAT register list read");
    res.json({ headers: result.headers, rows: result.rows, unclear: result.unclear });
  } catch (err) {
    if (aiUseId !== null) await settleAiUse(aiUseId, err instanceof ReportReadingError ? err.usage ?? null : null, false);
    if (err instanceof AiUnavailableError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof RegisterReadLimitError) return res.status(429).json({ error: err.message, code: "REGISTER_READING_LIMIT" });
    if (err instanceof UnreadableReportError) return res.status(400).json({ error: err.message });
    if (!(err instanceof ReportReadingError)) req.log.error({ err }, "PAT register list reading failed");
    res.status(502).json({ error: err instanceof ReportReadingError ? err.message : "ComplyTrack could not read this list just now. Try again later, or upload a spreadsheet." });
  }
});

// ── Reading a photo, scan, PDF or Word list for the other imports ──────────
// The same as the PAT register reading above, for RoomTrack rooms,
// contractors, FireTrack call points, GreenTrack equipment and the staff
// roster (lib/listReading.ts). Readings share the PAT monthly count, so
// REGISTER_READING_MONTHLY_LIMIT is the number of lists a business may have
// read a month across all imports. Each kind keeps its import's own access
// rule: owners and consultants, with the track switched on.
const LIST_READING_ACCESS: Record<ListReadingKind, RequestHandler[]> = {
  "room-track-rooms": [requireClientAdmin, requireService("roomtrack")],
  contractors: [requireClientAdmin],
  "fire-call-points": [requireClientAdmin, requireService("firetrack")],
  "greentrack-equipment": [requireClientAdmin, requireService("greentrack")],
  // Managers too: they upload their site's roster for the monthly roster check.
  "staff-roster": [requireUserManager],
};

/** Runs the access rule for the :kind in the path; unknown kinds are 404. */
const requireListReadingAccess: RequestHandler = (req, res, next) => {
  const kind = req.params.kind;
  if (!isListReadingKind(kind)) return res.status(404).json({ error: "Not found" });
  const chain = LIST_READING_ACCESS[kind];
  const run = (index: number): void => {
    if (index === chain.length) return next();
    chain[index](req, res, (err?: unknown) => (err ? next(err) : run(index + 1)));
  };
  run(0);
};

router.get("/imports/list-reading/:kind", requireAuth, requireListReadingAccess, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const month = (await getAccountToday(clientId)).slice(0, 7);
  const [sites, used, ai] = await Promise.all([
    importableSites(clientId, getActiveDepartmentId(req)), registerReadsThisMonth(clientId, month), getAiStatus(clientId),
  ]);
  res.json({ available: reportReadingConfigured(), monthlyLimit: registerReadingMonthlyLimit(), usedThisMonth: used, ai, sites });
});

router.post("/imports/list-reading/:kind/read", requireAuth, denyViewers, requireListReadingAccess, async (req, res) => {
  const kind = req.params.kind as ListReadingKind;
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!reportReadingConfigured()) {
    return res.status(503).json({ error: "Reading photos and documents is not switched on yet. Upload a spreadsheet instead.", code: "REGISTER_READING_UNAVAILABLE" });
  }
  const parsed = registerReadBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a photo, PDF or Word file of your list (8 MB at most)" });
  const sites = await importableSites(clientId, getActiveDepartmentId(req));
  const siteId = parsed.data.siteId ?? null;
  if (siteId !== null && !sites.some((site) => site.id === siteId)) return res.status(400).json({ error: "Choose one of your sites" });
  const trades = kind === "contractors" ? await getEffectiveOptionList(clientId, "fixtrack_trades") : undefined;

  const bytes = Buffer.from(parsed.data.data, "base64");
  const month = (await getAccountToday(clientId)).slice(0, 7);
  const limit = registerReadingMonthlyLimit();
  let aiUseId: number | null = null;
  try {
    // A file Claude cannot read is turned away before it counts towards the
    // limit or the AI allowance (lib/aiAllowance.ts).
    const result = await readList({ kind, bytes, mimeType: parsed.data.mimeType, fileName: parsed.data.fileName, sites, siteId, trades }, async () => {
      aiUseId = await claimAiUse({
        clientId, userId: req.currentUser?.id ?? null, feature: "list_reading",
        estimatePence: LIST_READING_ESTIMATE_PENCE, instead: "Upload a spreadsheet instead.",
      });
      if (!await claimRegisterRead(clientId, month, limit)) {
        throw new RegisterReadLimitError(`This business has had ${limit} lists read this month, the most allowed. Upload a spreadsheet instead, or ask ALPS.`);
      }
    });
    if (aiUseId !== null) await settleAiUse(aiUseId, result.usage, true);
    req.log.info({ clientId, kind, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, rows: result.rows.length }, "Import list read");
    res.json({ headers: result.headers, rows: result.rows, unclear: result.unclear, unclearRows: result.unclearRows });
  } catch (err) {
    if (aiUseId !== null) await settleAiUse(aiUseId, err instanceof ReportReadingError ? err.usage ?? null : null, false);
    if (err instanceof AiUnavailableError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof RegisterReadLimitError) return res.status(429).json({ error: err.message, code: "REGISTER_READING_LIMIT" });
    if (err instanceof UnreadableReportError) return res.status(400).json({ error: err.message });
    if (!(err instanceof ReportReadingError)) req.log.error({ err, kind }, "Import list reading failed");
    res.status(502).json({ error: err instanceof ReportReadingError ? err.message : "ComplyTrack could not read this list just now. Try again later, or upload a spreadsheet." });
  }
});

// ── Sorting a file into the right import ("Upload your lists") ─────────────
// Which import a photo, scan, PDF or Word list belongs in, among the imports
// this business has. It uses the AI allowance but not the monthly reading
// limit: the list is read (and counted) when the person opens it in its import.
const SORTABLE_LIST_SERVICE: Record<SortableListKind, ServiceKey | null> = {
  "pat-appliances": "pattrack",
  "room-track-rooms": "roomtrack",
  contractors: null,
  "fire-call-points": "firetrack",
  "greentrack-equipment": "greentrack",
  "staff-roster": null,
};

router.post("/imports/sort-list", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!reportReadingConfigured()) {
    return res.status(503).json({ error: "Reading photos and documents is not switched on yet. Upload a spreadsheet instead.", code: "REGISTER_READING_UNAVAILABLE" });
  }
  const parsed = registerReadBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a photo, PDF or Word file of your list (8 MB at most)" });
  const services = await getEntitledServices(clientId);
  const kinds = SORTABLE_LIST_KINDS.filter((kind) => {
    const service = SORTABLE_LIST_SERVICE[kind];
    return service === null || isEntitled(services, service);
  });
  let aiUseId: number | null = null;
  try {
    const result = await sortList({ bytes: Buffer.from(parsed.data.data, "base64"), mimeType: parsed.data.mimeType, fileName: parsed.data.fileName, kinds }, async () => {
      aiUseId = await claimAiUse({
        clientId, userId: req.currentUser?.id ?? null, feature: "list_reading",
        estimatePence: LIST_SORTING_ESTIMATE_PENCE, instead: "Choose which list it is yourself.",
      });
    });
    if (aiUseId !== null) await settleAiUse(aiUseId, result.usage, true);
    req.log.info({ clientId, kind: result.kind, model: result.model }, "Import list sorted");
    res.json({ kind: result.kind });
  } catch (err) {
    if (aiUseId !== null) await settleAiUse(aiUseId, null, false);
    if (err instanceof AiUnavailableError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof UnreadableReportError) return res.status(400).json({ error: err.message });
    req.log.error({ err }, "Import list sorting failed");
    res.status(502).json({ error: "ComplyTrack could not sort this file just now. Choose which list it is yourself." });
  }
});

router.get("/imports/room-track-rooms/template", requireAuth, requireClientAdmin, requireService("roomtrack"), sendTemplate("room-track-rooms", "roomtrack-rooms-template.csv"));
router.post("/imports/room-track-rooms", requireAuth, denyViewers, requireClientAdmin, requireService("roomtrack"), handleImport("room-track-rooms"));

router.get("/imports/compliance-checks/template", requireAuth, requireClientAdmin, sendTemplate("compliance-checks", "compliance-checks-template.csv"));
router.post("/imports/compliance-checks", requireAuth, denyViewers, requireClientAdmin, handleImport("compliance-checks"));

router.get("/imports/contractors/template", requireAuth, requireClientAdmin, sendTemplate("contractors", "contractors-template.csv"));
router.post("/imports/contractors", requireAuth, denyViewers, requireClientAdmin, handleImport("contractors"));

router.get("/imports/fire-call-points/template", requireAuth, requireClientAdmin, requireService("firetrack"), sendTemplate("fire-call-points", "firetrack-call-points-template.csv"));
router.post("/imports/fire-call-points", requireAuth, denyViewers, requireClientAdmin, requireService("firetrack"), handleImport("fire-call-points"));

export default router;
