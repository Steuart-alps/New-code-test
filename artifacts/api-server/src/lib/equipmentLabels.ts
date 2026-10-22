import { randomInt } from "node:crypto";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { EQUIPMENT_LABEL_KINDS, type EquipmentLabelKind, type EquipmentType } from "@workspace/db/schema";
import { getEntitledServices, isEntitled, type Entitlements, type ServiceKey } from "./services";
import { visibleSiteIdsSql } from "./departmentSites";
import { effectiveColdUnits } from "./coldUnits";
import { getAccountToday } from "./accountClock";
import { approvedFrequencies } from "./waterMonitoringPlan";
import { getFireSiteStatuses } from "./checkReminders";
import { greenCurrentHoursLateral, greenServiceHoursState } from "./greenHours";

/**
 * QR labels on equipment. Each label carries a random code; scanning it opens
 * /q/<code>, which shows whether the item is in date and offers its checks.
 * A code resolves only for someone signed in to the item's business who can
 * see the item's site and has its track, and every other case looks the same
 * as a code that does not exist, so a label reveals nothing to anyone else.
 */

export const KIND_INFO: Record<EquipmentLabelKind, { track: string; service: ServiceKey | null }> = {
  green_machine: { track: "GreenTrack", service: "greentrack" },
  pat_appliance: { track: "PATtrack", service: "pattrack" },
  hot_tub: { track: "TubTrack", service: "hottubtrack" },
  fire_call_point: { track: "FireTrack", service: "firetrack" },
  water_outlet: { track: "LegionellaTrack", service: "legionellatrack" },
  bike: { track: "BikeTrack", service: "biketrack" },
  room: { track: "RoomTrack", service: "roomtrack" },
  cold_unit: { track: "KitchenTrack", service: "kitchentrack" },
  equipment: { track: "Equipment list", service: null },
};

export const EQUIPMENT_TYPE_LABELS: Record<EquipmentType, string> = {
  cold_water_tank: "Cold water storage tank",
  calorifier: "Calorifier",
  boiler: "Boiler",
  water_heater: "Water heater",
  lift: "Lift",
  hoist: "Hoist",
  lifting_equipment: "Lifting equipment",
  pressure_system: "Pressure system",
  gas_appliance: "Gas appliance",
  air_conditioning: "Air conditioning",
  fire_extinguisher: "Fire extinguisher",
  ladder: "Ladder or step",
  other: "Other equipment",
};

/** Water checks an equipment item of each type takes. */
export const EQUIPMENT_WATER_CHECKS: Partial<Record<EquipmentType, Array<{ checkType: string; label: string; action: string }>>> = {
  cold_water_tank: [
    { checkType: "cold_tank_temp", label: "Monthly temperature", action: "Record temperature" },
    { checkType: "cold_tank_inspection", label: "6-monthly inspection", action: "Record inspection" },
    { checkType: "cold_tank_clean", label: "Clean and disinfect", action: "Record clean" },
  ],
  calorifier: [
    { checkType: "calorifier_temp", label: "Flow and return temperature", action: "Record temperature" },
    { checkType: "calorifier_inspection", label: "Annual inspection", action: "Record inspection" },
    { checkType: "calorifier_clean", label: "Clean and disinfect", action: "Record clean" },
  ],
};

export function isLabelKind(value: unknown): value is EquipmentLabelKind {
  return typeof value === "string" && (EQUIPMENT_LABEL_KINDS as readonly string[]).includes(value);
}

// ── Codes ────────────────────────────────────────────────────────────────────

// No 0/O, 1/I/L: the code is printed under the QR for reading out or typing.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

export function newLabelCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** A typed or scanned code, tidied: case and spaces do not matter. */
export function normaliseLabelCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

// ── Targets ──────────────────────────────────────────────────────────────────

export type LabelTarget = {
  kind: EquipmentLabelKind;
  ref: string;
  name: string;
  detail: string | null;
  siteId: number | null;
  siteName: string | null;
  active: boolean;
  /** Extra facts the scan page needs; not sent in lists. */
  extra?: Record<string, unknown>;
};

export type TargetFilter = {
  /** null = every site the caller can see; "none" = records without a site. */
  siteId: number | "none" | null;
  /** Only this record (its id, or a cold unit's "<site>:<unit>"). */
  ref?: string;
  includeArchived?: boolean;
};

type Row = Record<string, any>;
const rowsOf = (result: unknown) => ((result as { rows?: Row[] }).rows ?? []) as Row[];

/** The site rule every track uses: records without a site are business-wide. */
function siteScope(column: SQL, clientId: number, departmentId: number | null, filter: TargetFilter): SQL {
  const parts: SQL[] = [];
  if (departmentId !== null) parts.push(sql`(${column} IS NULL OR ${column} IN (${visibleSiteIdsSql(clientId, departmentId)}))`);
  if (filter.siteId === "none") parts.push(sql`${column} IS NULL`);
  else if (filter.siteId !== null) parts.push(sql`${column} = ${filter.siteId}`);
  return parts.length ? sql.join(parts, sql` AND `) : sql`true`;
}

function idFilter(column: SQL, filter: TargetFilter): SQL {
  if (filter.ref === undefined) return sql`true`;
  const id = Number(filter.ref);
  return Number.isSafeInteger(id) && id > 0 ? sql`${column} = ${id}` : sql`false`;
}

const joinText = (...parts: Array<string | null | undefined>) => parts.map(p => p?.trim()).filter(Boolean).join(" · ") || null;

async function tableTargets(kind: EquipmentLabelKind, clientId: number, departmentId: number | null, filter: TargetFilter): Promise<LabelTarget[]> {
  const scope = (alias: string) => siteScope(sql.raw(`${alias}.site_id`), clientId, departmentId, filter);
  const byId = (alias: string) => idFilter(sql.raw(`${alias}.id`), filter);
  const archived = (activeSql: SQL) => (filter.includeArchived ? sql`true` : activeSql);
  let result;
  switch (kind) {
    case "green_machine":
      result = await db.execute(sql`
        SELECT m.id, m.site_id, s.name AS site_name, m.name, m.type, m.make, m.model, m.serial_no, m.reg_no, m.active
        FROM green_machines m LEFT JOIN sites s ON s.id = m.site_id AND s.client_id = m.client_id
        WHERE m.client_id = ${clientId} AND ${scope("m")} AND ${byId("m")} AND ${archived(sql`m.active`)}
        ORDER BY m.name, m.id`);
      return rowsOf(result).map(r => ({
        kind, ref: String(r.id), name: r.name, siteId: r.site_id, siteName: r.site_name, active: r.active,
        detail: joinText([r.make, r.model].filter(Boolean).join(" "), r.serial_no ? `Serial ${r.serial_no}` : null, r.reg_no),
        extra: { machineType: r.type },
      }));
    case "pat_appliance":
      result = await db.execute(sql`
        SELECT a.id, a.site_id, s.name AS site_name, a.name, a.appliance_type, a.location, a.asset_tag, a.active
        FROM pat_appliances a LEFT JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
        WHERE a.client_id = ${clientId} AND ${scope("a")} AND ${byId("a")} AND ${archived(sql`a.active`)}
        ORDER BY a.name, a.id`);
      return rowsOf(result).map(r => ({
        kind, ref: String(r.id), name: r.name, siteId: r.site_id, siteName: r.site_name, active: r.active,
        detail: joinText(r.asset_tag ? `Tag ${r.asset_tag}` : null, r.location),
      }));
    case "hot_tub":
      result = await db.execute(sql`
        SELECT t.id, t.site_id, s.name AS site_name, t.name, t.description, t.active
        FROM hot_tubs t LEFT JOIN sites s ON s.id = t.site_id AND s.client_id = t.client_id
        WHERE t.client_id = ${clientId} AND ${scope("t")} AND ${byId("t")} AND ${archived(sql`t.active`)}
        ORDER BY t.name, t.id`);
      return rowsOf(result).map(r => ({
        kind, ref: String(r.id), name: r.name, siteId: r.site_id, siteName: r.site_name, active: r.active,
        detail: r.description || null,
      }));
    case "fire_call_point":
      result = await db.execute(sql`
        SELECT p.id, p.site_id, s.name AS site_name, p.name, p.archived_at IS NULL AS active
        FROM fire_call_points p LEFT JOIN sites s ON s.id = p.site_id AND s.client_id = p.client_id
        WHERE p.client_id = ${clientId} AND ${scope("p")} AND ${byId("p")} AND ${archived(sql`p.archived_at IS NULL`)}
        ORDER BY p.name, p.id`);
      return rowsOf(result).map(r => ({
        kind, ref: String(r.id), name: r.name, siteId: r.site_id, siteName: r.site_name, active: r.active,
        detail: "Fire alarm call point",
      }));
    case "water_outlet":
      result = await db.execute(sql`
        SELECT o.id, o.site_id, s.name AS site_name, o.name, o.type, o.location, o.active
        FROM legionella_sentinel_outlets o LEFT JOIN sites s ON s.id = o.site_id AND s.client_id = o.client_id
        WHERE o.client_id = ${clientId} AND ${scope("o")} AND ${byId("o")} AND ${archived(sql`o.active`)}
        ORDER BY o.sort_order, o.name, o.id`);
      return rowsOf(result).map(r => ({
        kind, ref: String(r.id), name: r.name, siteId: r.site_id, siteName: r.site_name, active: r.active,
        detail: joinText(OUTLET_TYPE_LABELS[r.type] ?? null, r.location), extra: { outletType: r.type },
      }));
    case "bike":
      result = await db.execute(sql`
        SELECT b.id, b.site_id, s.name AS site_name, b.ref, b.name, b.type, b.status, b.active
        FROM bikes b LEFT JOIN sites s ON s.id = b.site_id AND s.client_id = b.client_id
        WHERE b.client_id = ${clientId} AND ${scope("b")} AND ${byId("b")} AND ${archived(sql`b.active`)}
        ORDER BY b.ref, b.id`);
      return rowsOf(result).map(r => ({
        kind, ref: String(r.id), name: r.name || r.ref, siteId: r.site_id, siteName: r.site_name, active: r.active,
        detail: joinText(r.name ? r.ref : null, r.type), extra: { bikeStatus: r.status },
      }));
    case "room":
      result = await db.execute(sql`
        SELECT r.id, r.site_id, s.name AS site_name, r.room_number, r.name, r.floor, r.active
        FROM room_track_rooms r LEFT JOIN sites s ON s.id = r.site_id AND s.client_id = r.client_id
        WHERE r.client_id = ${clientId} AND ${scope("r")} AND ${byId("r")} AND ${archived(sql`r.active`)}
        ORDER BY r.room_number, r.id`);
      return rowsOf(result).map(r => ({
        kind, ref: String(r.id), name: joinText(r.room_number ? `Room ${r.room_number}` : null, r.name) ?? `Room ${r.id}`,
        siteId: r.site_id, siteName: r.site_name, active: r.active, detail: r.floor ? `Floor ${r.floor}` : null,
      }));
    case "equipment":
      result = await db.execute(sql`
        SELECT e.id, e.site_id, s.name AS site_name, e.name, e.type, e.location, e.make, e.model, e.serial_no, e.active
        FROM equipment_items e LEFT JOIN sites s ON s.id = e.site_id AND s.client_id = e.client_id
        WHERE e.client_id = ${clientId} AND ${scope("e")} AND ${byId("e")} AND ${archived(sql`e.active`)}
        ORDER BY e.name, e.id`);
      return rowsOf(result).map(r => ({
        kind, ref: String(r.id), name: r.name, siteId: r.site_id, siteName: r.site_name, active: r.active,
        detail: joinText(EQUIPMENT_TYPE_LABELS[r.type as EquipmentType] ?? null, r.location),
        extra: { equipmentType: r.type },
      }));
    case "cold_unit":
      return coldUnitTargets(clientId, departmentId, filter);
  }
}

export const OUTLET_TYPE_LABELS: Record<string, string> = {
  hot: "Hot outlet", cold: "Cold outlet", calorifier: "Calorifier", tmv: "TMV outlet", little_used: "Little-used outlet",
};

/** Fridges and freezers, one per site that uses them ("0" for a business without sites). */
async function coldUnitTargets(clientId: number, departmentId: number | null, filter: TargetFilter): Promise<LabelTarget[]> {
  const wanted = filter.ref?.match(/^(\d+):([A-Za-z0-9_-]{1,40})$/);
  if (filter.ref !== undefined && !wanted) return [];
  const sites = rowsOf(await db.execute(sql`
    SELECT s.id, s.name FROM sites s
    WHERE s.client_id = ${clientId} AND ${siteScope(sql`s.id`, clientId, departmentId, { ...filter, siteId: filter.siteId === "none" ? null : filter.siteId })}
    ORDER BY s.name, s.id`));
  const hasSites = rowsOf(await db.execute(sql`SELECT 1 FROM sites WHERE client_id = ${clientId} LIMIT 1`)).length > 0;
  const scopes: Array<{ id: number | null; name: string | null }> = hasSites
    ? (filter.siteId === "none" ? [] : sites.map(s => ({ id: Number(s.id), name: s.name as string })))
    : (filter.siteId === null || filter.siteId === "none" ? [{ id: null, name: null }] : []);
  const out: LabelTarget[] = [];
  for (const site of scopes) {
    if (wanted && Number(wanted[1]) !== (site.id ?? 0)) continue;
    for (const unit of await effectiveColdUnits(clientId, site.id)) {
      if (wanted && unit.id !== wanted[2]) continue;
      out.push({
        kind: "cold_unit", ref: `${site.id ?? 0}:${unit.id}`, name: unit.name, siteId: site.id, siteName: site.name,
        active: true, detail: unit.type === "fridge" ? "Fridge" : "Freezer", extra: { unitType: unit.type },
      });
    }
  }
  return out;
}

/** Every record the caller could label, for the tracks the business has. */
export async function listLabelTargets(
  clientId: number, departmentId: number | null, services: Entitlements, filter: TargetFilter,
  kinds: readonly EquipmentLabelKind[] = EQUIPMENT_LABEL_KINDS,
): Promise<LabelTarget[]> {
  const out: LabelTarget[] = [];
  for (const kind of kinds) {
    const service = KIND_INFO[kind].service;
    if (service && !isEntitled(services, service)) continue;
    out.push(...await tableTargets(kind, clientId, departmentId, filter));
  }
  return out;
}

export async function findLabelTarget(
  clientId: number, departmentId: number | null, kind: EquipmentLabelKind, ref: string,
): Promise<LabelTarget | null> {
  const services = await getEntitledServices(clientId);
  const [target] = await listLabelTargets(clientId, departmentId, services, { siteId: null, ref, includeArchived: true }, [kind]);
  return target ?? null;
}

// ── Labels ───────────────────────────────────────────────────────────────────

export type ActiveLabel = { id: number; code: string; kind: EquipmentLabelKind; targetRef: string; createdAt: string };

export async function activeLabels(clientId: number): Promise<Map<string, ActiveLabel>> {
  const result = await db.execute(sql`
    SELECT id, code, kind, target_ref, created_at FROM equipment_labels
    WHERE client_id = ${clientId} AND replaced_at IS NULL`);
  return new Map(rowsOf(result).map(r => [`${r.kind}:${r.target_ref}`, {
    id: r.id, code: r.code, kind: r.kind, targetRef: r.target_ref, createdAt: r.created_at,
  }]));
}

const isUniqueViolation = (err: unknown) => (err as { code?: string; cause?: { code?: string } })?.code === "23505"
  || (err as { cause?: { code?: string } })?.cause?.code === "23505";

/** The live label for each target, creating any that do not have one yet. */
export async function ensureLabels(clientId: number, userId: number | null, targets: Array<{ kind: EquipmentLabelKind; ref: string }>): Promise<Map<string, ActiveLabel>> {
  let labels = await activeLabels(clientId);
  for (const target of targets) {
    if (labels.has(`${target.kind}:${target.ref}`)) continue;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await db.execute(sql`
          INSERT INTO equipment_labels (client_id, code, kind, target_ref, created_by)
          VALUES (${clientId}, ${newLabelCode()}, ${target.kind}, ${target.ref}, ${userId})
          ON CONFLICT (client_id, kind, target_ref) WHERE replaced_at IS NULL DO NOTHING`);
        break;
      } catch (err) {
        // A code already in use somewhere: draw another.
        if (!isUniqueViolation(err) || attempt === 7) throw err;
      }
    }
  }
  if (targets.length) labels = await activeLabels(clientId);
  return labels;
}

/** Retire the target's label (its code stops working) and issue a new one. */
export async function replaceLabel(clientId: number, userId: number | null, kind: EquipmentLabelKind, ref: string): Promise<ActiveLabel> {
  await db.execute(sql`
    UPDATE equipment_labels SET replaced_at = now()
    WHERE client_id = ${clientId} AND kind = ${kind} AND target_ref = ${ref} AND replaced_at IS NULL`);
  const labels = await ensureLabels(clientId, userId, [{ kind, ref }]);
  return labels.get(`${kind}:${ref}`)!;
}

export async function findActiveLabel(code: string): Promise<{ clientId: number; kind: EquipmentLabelKind; targetRef: string } | null> {
  const [row] = rowsOf(await db.execute(sql`
    SELECT client_id, kind, target_ref FROM equipment_labels WHERE code = ${code} AND replaced_at IS NULL LIMIT 1`));
  if (!row || !isLabelKind(row.kind)) return null;
  return { clientId: Number(row.client_id), kind: row.kind, targetRef: row.target_ref };
}

// ── Scan summary ─────────────────────────────────────────────────────────────

export type ScanState = "ok" | "due_soon" | "overdue" | "never" | "problem" | "info";
export type ScanStatus = { label: string; state: ScanState; text: string; note?: string };
export type ScanAction = { label: string; href: string; primary?: boolean };
export type ScanHistory = { date: string; text: string; state: ScanState };
export type ScanSummary = {
  code: string; clientId: number; kind: EquipmentLabelKind; track: string;
  name: string; detail: string | null; siteId: number | null; siteName: string | null; active: boolean;
  statuses: ScanStatus[]; actions: ScanAction[]; history: ScanHistory[];
};

export type ScanViewer = { canRecord: boolean; canAdmin: boolean; services: Entitlements };

const MS_DAY = 86_400_000;
const isoDay = (value: unknown): string | null => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_DAY);
export const formatDay = (iso: string) => new Date(`${iso}T00:00:00Z`)
  .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_DAY).toISOString().slice(0, 10);

/** In date, due soon or overdue from a due date; "last done" when there is none. */
export function dueStatus(label: string, dueIso: string | null, today: string, lastIso: string | null = null, windowDays = 30): ScanStatus {
  if (!dueIso) {
    return lastIso ? { label, state: "info", text: `Last done ${formatDay(lastIso)}` }
      : { label, state: "never", text: "Nothing recorded yet" };
  }
  const days = daysBetween(today, dueIso);
  if (days < 0) return { label, state: "overdue", text: `Overdue since ${formatDay(dueIso)}` };
  if (days === 0) return { label, state: "due_soon", text: "Due today" };
  if (days <= windowDays) return { label, state: "due_soon", text: `Due in ${days} day${days === 1 ? "" : "s"} (${formatDay(dueIso)})` };
  return { label, state: "ok", text: `In date until ${formatDay(dueIso)}` };
}

const humanise = (value: string) => value.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());

const INSPECTION_LABELS: Record<string, string> = {
  thorough_examination: "PUWER inspection",
  loler_examination: "LOLER examination",
  annual_inspection: "Annual inspection",
  periodic_inspection: "Periodic inspection",
  nsts_test: "NSTS sprayer test",
  nsts: "NSTS sprayer test",
};

const query = (q: Record<string, string | number>) => new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();

async function waterFrequencies(clientId: number, siteId: number | null, checkTypes: string[]): Promise<Record<string, number> | null> {
  if (siteId === null) return null;
  const [row] = rowsOf(await db.execute(sql`
    SELECT profile FROM track_control_profiles WHERE client_id = ${clientId} AND site_id = ${siteId} AND module = 'legionella' LIMIT 1`));
  return approvedFrequencies(row?.profile ?? null, checkTypes, "frequencyDays");
}

function faultAction(target: LabelTarget, viewer: ScanViewer): ScanAction[] {
  if (!viewer.canRecord || !isEntitled(viewer.services, "fixtrack")) return [];
  const where = joinText(target.name, target.siteName) ?? target.name;
  return [{ label: "Report a fault", href: `/fix-track?${query({ report: "1", title: `Fault: ${target.name}`, location: where, ...(target.siteId ? { siteId: target.siteId } : {}) })}` }];
}

export async function buildScanSummary(code: string, clientId: number, target: LabelTarget, viewer: ScanViewer): Promise<ScanSummary> {
  const today = await getAccountToday(clientId);
  const statuses: ScanStatus[] = [];
  const actions: ScanAction[] = [];
  const history: ScanHistory[] = [];
  const id = Number(target.ref);
  const record = viewer.canRecord && target.active;

  switch (target.kind) {
    case "green_machine": {
      const inspections = rowsOf(await db.execute(sql`
        SELECT DISTINCT ON (inspection_type) inspection_type, inspection_date, next_inspection_date, result, safe_to_operate
        FROM green_puwer_inspections WHERE client_id = ${clientId} AND machine_id = ${id}
        ORDER BY inspection_type, inspection_date DESC, id DESC`));
      if (!inspections.length) statuses.push({ label: "PUWER inspection", state: "never", text: "No inspection recorded yet" });
      for (const row of inspections) {
        const label = INSPECTION_LABELS[row.inspection_type] ?? humanise(row.inspection_type);
        const done = isoDay(row.inspection_date);
        if (row.result === "fail" || row.safe_to_operate === false) {
          statuses.push({ label, state: "problem", text: `Failed on ${done ? formatDay(done) : "the last inspection"}: not safe to use` });
        } else statuses.push(dueStatus(label, isoDay(row.next_inspection_date), today, done));
      }
      const [service] = rowsOf(await db.execute(sql`
        SELECT service_date, next_service_date, next_service_hours FROM green_service_records
        WHERE client_id = ${clientId} AND machine_id = ${id} ORDER BY service_date DESC, id DESC LIMIT 1`));
      statuses.push(dueStatus("Service", isoDay(service?.next_service_date), today, isoDay(service?.service_date), 14));
      const [meter] = rowsOf(await db.execute(sql`SELECT hours, to_char(day, 'YYYY-MM-DD') AS day FROM ${greenCurrentHoursLateral(sql`${id}`, sql`${clientId}`)} cur`));
      const currentHours = meter?.hours == null ? null : Number(meter.hours);
      const nextServiceHours = service?.next_service_hours == null ? null : Number(service.next_service_hours);
      const byHours = greenServiceHoursState(currentHours, nextServiceHours);
      statuses.push(currentHours == null
        ? { label: "Hour meter", state: "never", text: "No reading yet" }
        : byHours === "overdue" || byHours === "due_soon"
          ? { label: "Hour meter", state: byHours, text: `${currentHours} hours on ${formatDay(meter.day)}: service ${byHours === "overdue" ? "overdue" : "due"} at ${nextServiceHours} hours` }
          : { label: "Hour meter", state: "info", text: `${currentHours} hours on ${formatDay(meter.day)}${nextServiceHours != null ? `; next service at ${nextServiceHours}` : ""}` });
      const [defects] = rowsOf(await db.execute(sql`
        SELECT count(*)::int AS open, bool_or(out_of_service) AS out_of_service FROM green_defects
        WHERE client_id = ${clientId} AND machine_id = ${id} AND status NOT IN ('resolved', 'closed')`));
      statuses.push(defects?.open > 0
        ? { label: "Faults", state: "problem", text: `${defects.open} open${defects.out_of_service ? ": out of service, do not use" : ""}` }
        : { label: "Faults", state: "ok", text: "None open" });
      const checks = rowsOf(await db.execute(sql`
        SELECT check_date, result, operator FROM green_pre_use_checks
        WHERE client_id = ${clientId} AND machine_id = ${id} ORDER BY check_date DESC, id DESC LIMIT 6`));
      const doneToday = checks.find(c => isoDay(c.check_date) === today);
      statuses.unshift(doneToday
        ? { label: "Today's pre-use check", state: doneToday.result === "fail" ? "problem" : "ok", text: doneToday.result === "fail" ? "Done today: failed" : "Done today" }
        : { label: "Today's pre-use check", state: "due_soon", text: "Not done yet today" });
      for (const c of checks) {
        const day = isoDay(c.check_date)!;
        history.push({ date: day, state: c.result === "fail" ? "problem" : "ok", text: `Pre-use check: ${c.result === "fail" ? "fail" : "pass"}${c.operator ? `, ${c.operator}` : ""}` });
      }
      if (record) {
        actions.push({ label: doneToday ? "Record another pre-use check" : "Start today's pre-use check", href: `/green-track?${query({ machine: id, open: "pre-use" })}`, primary: true });
        actions.push({ label: "Report a fault", href: `/green-track?${query({ machine: id, open: "defect" })}` });
        if (target.extra?.machineType === "sprayer_spreader") {
          actions.push({ label: "Record spraying", href: `/green-track?${query({ machine: id, open: "spraying" })}` });
        }
        actions.push({ label: "Log hour meter reading", href: `/green-track?${query({ machine: id, open: "hours" })}` });
        actions.push({ label: "Log fuel", href: `/green-track?${query({ machine: id, open: "fuel" })}` });
        if (viewer.canAdmin) {
          actions.push({ label: "Record a service", href: `/green-track?${query({ machine: id, open: "service" })}` });
          actions.push({ label: "Record an inspection", href: `/green-track?${query({ machine: id, open: "inspection" })}` });
        }
      }
      break;
    }
    case "pat_appliance": {
      const tests = rowsOf(await db.execute(sql`
        SELECT test_date, result, next_test_date FROM pat_tests
        WHERE client_id = ${clientId} AND appliance_id = ${id} ORDER BY test_date DESC, created_at DESC LIMIT 5`));
      const last = tests[0];
      if (last?.result === "fail") statuses.push({ label: "PAT test", state: "problem", text: `Failed on ${formatDay(isoDay(last.test_date)!)}: do not use` });
      else statuses.push(dueStatus("PAT test", isoDay(last?.next_test_date), today, isoDay(last?.test_date)));
      for (const t of tests) history.push({ date: isoDay(t.test_date)!, state: t.result === "fail" ? "problem" : "ok", text: `PAT test: ${t.result}` });
      if (record) actions.push({ label: "Record a PAT test", href: `/pat-track?${query({ appliance: id, open: "test" })}`, primary: true });
      actions.push(...faultAction(target, viewer));
      break;
    }
    case "hot_tub": {
      const latest = rowsOf(await db.execute(sql`
        SELECT DISTINCT ON (check_type) check_type, check_date, result FROM hot_tub_checks
        WHERE client_id = ${clientId} AND hot_tub_id = ${id}
        ORDER BY check_type, check_date DESC, id DESC`));
      for (const type of ["water_chemistry", "temperature"]) {
        const row = latest.find(r => r.check_type === type);
        const label = type === "water_chemistry" ? "Today's water test" : "Today's temperature";
        if (row && isoDay(row.check_date) === today) {
          statuses.push({ label, state: row.result === "pass" ? "ok" : "problem", text: row.result === "pass" ? "Done today" : "Done today: failed" });
        } else statuses.push({ label, state: "due_soon", text: "Not done yet today" });
      }
      for (const row of latest.filter(r => !["water_chemistry", "temperature"].includes(r.check_type))) {
        history.push({ date: isoDay(row.check_date)!, state: row.result === "pass" ? "ok" : "problem", text: `${humanise(row.check_type)}: ${row.result}` });
      }
      history.sort((a, b) => b.date.localeCompare(a.date));
      if (record) actions.push({ label: "Record a check", href: `/hot-tub?${query({ tub: id, open: "check" })}`, primary: true });
      actions.push(...faultAction(target, viewer));
      break;
    }
    case "fire_call_point": {
      const tests = rowsOf(await db.execute(sql`
        SELECT check_date, result FROM fire_safety_checks
        WHERE client_id = ${clientId} AND call_point_id = ${id} AND check_type = 'alarm'
        ORDER BY check_date DESC, id DESC LIMIT 5`));
      if (target.siteId !== null) {
        const alarm = (await getFireSiteStatuses(clientId, { siteId: target.siteId })).find(s => s.checkType === "alarm");
        if (alarm) statuses.push(dueStatus("Weekly alarm test at this site", alarm.dueDate, today, alarm.lastDate, 2));
      }
      statuses.push(tests[0]
        ? { label: "This call point", state: "info", text: `Last used for the alarm test on ${formatDay(isoDay(tests[0].check_date)!)}` }
        : { label: "This call point", state: "never", text: "Not used for an alarm test yet" });
      for (const t of tests) history.push({ date: isoDay(t.check_date)!, state: t.result === "fail" ? "problem" : "ok", text: `Alarm test: ${t.result}` });
      if (record) actions.push({ label: "Record this week's alarm test", href: `/fire-safety?${query({ callPoint: id, open: "alarm" })}`, primary: true });
      actions.push(...faultAction(target, viewer));
      break;
    }
    case "water_outlet": {
      const checkType = OUTLET_CHECK_TYPES[String(target.extra?.outletType)] ?? "hot_sentinel_temp";
      const flush = checkType === "outlet_flush";
      const readings = rowsOf(await db.execute(sql`
        SELECT check_date, result, temperature FROM legionella_checks
        WHERE client_id = ${clientId} AND outlet_id = ${id} ORDER BY check_date DESC, id DESC LIMIT 5`));
      const frequencies = await waterFrequencies(clientId, target.siteId, [checkType]);
      const last = readings[0];
      const lastDay = isoDay(last?.check_date);
      const status = last?.result === "fail" || last?.result === "action_required"
        ? { label: flush ? "Weekly flush" : "Temperature check", state: "problem" as const, text: `${flush ? "Failed" : "Out of range"} on ${formatDay(lastDay!)}` }
        : dueStatus(flush ? "Weekly flush" : "Temperature check", lastDay && frequencies ? addDays(lastDay, frequencies[checkType]) : null, today, lastDay, 5);
      if (!frequencies) status.note = "Due dates show once the site's water plan is approved.";
      statuses.push(status);
      for (const r of readings) {
        history.push({ date: isoDay(r.check_date)!, state: r.result === "pass" ? "ok" : "problem", text: flush
          ? `Flushed: ${r.result === "pass" ? "pass" : "fail"}`
          : `${r.temperature != null ? `${Number(r.temperature)}°C` : "Reading"}: ${r.result === "pass" ? "in range" : "out of range"}` });
      }
      if (record) actions.push({ label: flush ? "Record a flush" : "Record a temperature", href: `/legionella?${query({ outlet: id, open: "reading" })}`, primary: true });
      actions.push(...faultAction(target, viewer));
      break;
    }
    case "bike": {
      const bikeStatus = String(target.extra?.bikeStatus ?? "available");
      statuses.push({
        label: "Status", text: humanise(bikeStatus),
        state: bikeStatus === "available" ? "ok" : bikeStatus === "hired" ? "info" : "problem",
      });
      const checks = rowsOf(await db.execute(sql`
        SELECT check_date, check_type, overall_result FROM bike_checks
        WHERE client_id = ${clientId} AND bike_id = ${id} ORDER BY check_date DESC, id DESC LIMIT 5`));
      const last = checks[0];
      statuses.push(last
        ? { label: "Last safety check", state: last.overall_result === "fail" ? "problem" : "info", text: `${formatDay(isoDay(last.check_date)!)}: ${last.overall_result ?? "recorded"}` }
        : { label: "Last safety check", state: "never", text: "No check recorded yet" });
      for (const c of checks) history.push({ date: isoDay(c.check_date)!, state: c.overall_result === "fail" ? "problem" : "ok", text: `${humanise(c.check_type ?? "check")}: ${c.overall_result ?? "recorded"}` });
      if (record) {
        const label = bikeStatus === "hired" ? "Record the return" : bikeStatus === "available" ? "Start a hire (with safety check)" : "Open this bike";
        actions.push({ label, href: `/bike-track?${query({ bike: id })}`, primary: true });
      }
      actions.push(...faultAction(target, viewer));
      break;
    }
    case "room": {
      const checks = rowsOf(await db.execute(sql`
        SELECT check_date, status FROM room_track_checks
        WHERE client_id = ${clientId} AND room_id = ${id} ORDER BY check_date DESC, id DESC LIMIT 5`));
      const doneToday = checks.find(c => isoDay(c.check_date) === today);
      statuses.push(doneToday
        ? { label: "Today's room check", state: doneToday.status === "fail" ? "problem" : "ok", text: `Done today: ${humanise(String(doneToday.status ?? "recorded"))}` }
        : { label: "Today's room check", state: "due_soon", text: "Not done yet today" });
      for (const c of checks) history.push({ date: isoDay(c.check_date)!, state: c.status === "fail" ? "problem" : "ok", text: `Room check: ${humanise(String(c.status ?? "recorded"))}` });
      if (record) actions.push({ label: "Record today's room check", href: `/room-track?${query({ room: id, open: "check" })}`, primary: true });
      actions.push(...faultAction(target, viewer));
      break;
    }
    case "cold_unit": {
      const records = rowsOf(await db.execute(sql`
        SELECT record_date, cold_food FROM food_safety_records
        WHERE client_id = ${clientId} AND ${target.siteId === null ? sql`site_id IS NULL` : sql`site_id = ${target.siteId}`}
          AND record_date > ${addDays(today, -7)}::date AND record_date <= ${today}::date
        ORDER BY record_date DESC`));
      const readingsOn = (row: Row | undefined) => {
        const rows = Array.isArray(row?.cold_food) ? row!.cold_food as Row[] : [];
        return rows.find(r => typeof r?.unit === "string" && r.unit.trim().toLowerCase() === target.name.toLowerCase()) ?? null;
      };
      const todays = readingsOn(records.find(r => isoDay(r.record_date) === today));
      const reading = (value: unknown) => (typeof value === "string" && value.trim() ? `${value.trim()}°C` : null);
      statuses.push(reading(todays?.tempAm)
        ? { label: "Morning reading", state: "ok", text: reading(todays!.tempAm)! }
        : { label: "Morning reading", state: "due_soon", text: "Not recorded yet today" });
      statuses.push(reading(todays?.tempPm)
        ? { label: "Afternoon reading", state: "ok", text: reading(todays!.tempPm)! }
        : { label: "Afternoon reading", state: "due_soon", text: "Not recorded yet today" });
      for (const row of records) {
        const r = readingsOn(row);
        if (!r) continue;
        const text = [reading(r.tempAm) && `AM ${reading(r.tempAm)}`, reading(r.tempPm) && `PM ${reading(r.tempPm)}`].filter(Boolean).join(", ");
        if (text) history.push({ date: isoDay(row.record_date)!, state: r.correctiveAction ? "problem" : "ok", text: r.correctiveAction ? `${text} (action taken: ${r.correctiveAction})` : text });
      }
      if (record) {
        actions.push({ label: "Record a temperature", primary: true,
          href: `/kitchen?${query({ ...(target.siteId ? { siteId: target.siteId } : {}), coldUnit: target.name })}` });
      }
      actions.push(...faultAction(target, viewer));
      break;
    }
    case "equipment": {
      const type = String(target.extra?.equipmentType ?? "other") as EquipmentType;
      const waterChecks = EQUIPMENT_WATER_CHECKS[type] ?? [];
      if (waterChecks.length && isEntitled(viewer.services, "legionellatrack")) {
        // Older water checks were not linked to an item: while this is the only
        // item of its type at the site, the site's checks of that type count.
        const [{ count: siblings }] = rowsOf(await db.execute(sql`
          SELECT count(*)::int AS count FROM equipment_items
          WHERE client_id = ${clientId} AND type = ${type} AND active
            AND ${target.siteId === null ? sql`site_id IS NULL` : sql`site_id = ${target.siteId}`}`));
        const onlyOne = siblings <= 1;
        const types = waterChecks.map(c => c.checkType);
        const frequencies = await waterFrequencies(clientId, target.siteId, types);
        const latest = rowsOf(await db.execute(sql`
          SELECT DISTINCT ON (check_type) check_type, check_date, result, temperature FROM legionella_checks
          WHERE client_id = ${clientId} AND check_type IN (${sql.join(types.map(t => sql`${t}`), sql`, `)})
            AND (equipment_id = ${id} ${onlyOne ? sql`OR (equipment_id IS NULL AND ${target.siteId === null ? sql`site_id IS NULL` : sql`site_id = ${target.siteId}`})` : sql``})
          ORDER BY check_type, check_date DESC, id DESC`));
        for (const check of waterChecks) {
          const row = latest.find(r => r.check_type === check.checkType);
          const last = isoDay(row?.check_date);
          const status = row && (row.result === "fail" || row.result === "action_required")
            ? { label: check.label, state: "problem" as const, text: `Failed on ${formatDay(last!)}` }
            : dueStatus(check.label, last && frequencies ? addDays(last, frequencies[check.checkType]) : null, today, last, 7);
          if (!frequencies) status.note = "Due dates show once the site's water plan is approved.";
          statuses.push(status);
          if (record) actions.push({ label: check.action, href: `/legionella?${query({ equipment: id, open: check.checkType })}`, primary: actions.length === 0 });
        }
        const recent = rowsOf(await db.execute(sql`
          SELECT check_date, check_type, result, temperature FROM legionella_checks
          WHERE client_id = ${clientId} AND equipment_id = ${id} ORDER BY check_date DESC, id DESC LIMIT 5`));
        for (const r of recent) {
          const label = waterChecks.find(c => c.checkType === r.check_type)?.label ?? humanise(r.check_type);
          history.push({ date: isoDay(r.check_date)!, state: r.result === "pass" ? "ok" : "problem", text: `${label}: ${r.temperature != null ? `${Number(r.temperature)}°C, ` : ""}${r.result}` });
        }
      }
      if (type === "fire_extinguisher" && isEntitled(viewer.services, "firetrack") && target.siteId !== null) {
        const fire = await getFireSiteStatuses(clientId, { siteId: target.siteId });
        const weekly = fire.find(s => s.checkType === "extinguishers");
        const service = fire.find(s => s.checkType === "extinguisher_service");
        if (weekly) statuses.push(dueStatus("Extinguisher check at this site", weekly.dueDate, today, weekly.lastDate, 2));
        if (service) statuses.push(dueStatus("Annual extinguisher service", service.dueDate, today, service.lastDate));
        if (record) actions.push({ label: "Record an extinguisher check", primary: actions.length === 0,
          href: `/fire-safety?${query({ open: "extinguishers", siteId: target.siteId, location: target.name })}` });
      }
      // Compliance Checks linked to the item: its gas safety, LOLER, service.
      const items = rowsOf(await db.execute(sql`
        SELECT ci.id, ci.title, ci.due_date, ci.status, ci.completed_at,
          (SELECT max(c.expiry_date) FROM certificates c WHERE c.item_id = ci.id AND c.outcome <> 'unsatisfactory') AS certificate_expiry
        FROM compliance_items ci
        WHERE ci.client_id = ${clientId} AND ci.equipment_id = ${id}
        ORDER BY ci.due_date NULLS LAST, ci.id`));
      for (const item of items) {
        const due = isoDay(item.due_date) ?? isoDay(item.certificate_expiry);
        const status = item.status === "completed" && !due
          ? { label: item.title, state: "ok" as const, text: `Done ${item.completed_at ? formatDay(isoDay(item.completed_at)!) : ""}`.trim() }
          : dueStatus(item.title, due, today, isoDay(item.completed_at));
        statuses.push(status);
        actions.push({ label: `Open "${item.title}"`, href: `/items/${item.id}` });
      }
      if (!statuses.length) {
        statuses.push({ label: "Checks", state: "never", text: "No checks linked to this item yet" });
      }
      actions.push(...faultAction(target, viewer));
      history.sort((a, b) => b.date.localeCompare(a.date));
      break;
    }
  }

  return {
    code, clientId, kind: target.kind, track: KIND_INFO[target.kind].track,
    name: target.name, detail: target.detail, siteId: target.siteId, siteName: target.siteName, active: target.active,
    statuses, actions, history: history.slice(0, 6),
  };
}

const OUTLET_CHECK_TYPES: Record<string, string> = {
  hot: "hot_sentinel_temp", cold: "cold_sentinel_temp", calorifier: "calorifier_temp", tmv: "hot_sentinel_temp",
  little_used: "outlet_flush",
};
