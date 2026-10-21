import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, denyViewers, getActiveDepartmentId, isDepartmentLead } from "../middleware/requireAuth";
import { requireService } from "../lib/services";
import { filterName } from "../lib/contentFilter";
import { getEffectiveOptionList } from "../lib/formOptions";
import { siteVisibleSql } from "../lib/departmentSites";
import {
  CSV_IMPORT_MAX_CELL_LENGTH,
  CSV_IMPORT_MAX_COLUMNS,
  CSV_IMPORT_MAX_ROWS,
  importTemplateCsv,
  mapImportRows,
  normaliseHeader,
  normaliseKey,
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

router.get("/imports/room-track-rooms/template", requireAuth, requireClientAdmin, requireService("roomtrack"), sendTemplate("room-track-rooms", "roomtrack-rooms-template.csv"));
router.post("/imports/room-track-rooms", requireAuth, denyViewers, requireClientAdmin, requireService("roomtrack"), handleImport("room-track-rooms"));

router.get("/imports/contractors/template", requireAuth, requireClientAdmin, sendTemplate("contractors", "contractors-template.csv"));
router.post("/imports/contractors", requireAuth, denyViewers, requireClientAdmin, handleImport("contractors"));

router.get("/imports/fire-call-points/template", requireAuth, requireClientAdmin, requireService("firetrack"), sendTemplate("fire-call-points", "firetrack-call-points-template.csv"));
router.post("/imports/fire-call-points", requireAuth, denyViewers, requireClientAdmin, requireService("firetrack"), handleImport("fire-call-points"));

export default router;
