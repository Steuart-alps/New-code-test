import type { Request } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { EQUIPMENT_TYPE_PARTS, type EquipmentPart, type EquipmentType } from "@workspace/db/schema";
import { appendAuditEvent } from "./audit";
import { resolveAssigneeChange } from "./assignees";

/**
 * Parts of an equipment item that expire on a printed date, such as a
 * defibrillator's pads and battery. Each part with a date is one Compliance
 * Check (compliance_items.equipment_part) whose due date is the expiry date,
 * so it shows on the dashboard and Compliance Checks, its reminders go to the
 * person responsible (lib/dueItems.ts), and the item's QR label says whether
 * it is in date. Marking the check done asks for the new part's expiry date
 * (PATCH /compliance-items/:id/status with nextDueDate).
 */

type Row = Record<string, any>;
const rowsOf = (result: unknown) => ((result as { rows?: Row[] }).rows ?? []) as Row[];

export const EQUIPMENT_PART_INFO: Record<EquipmentPart, { label: string; title: string; description: string }> = {
  defib_pads: {
    label: "Pads",
    title: "Replace defibrillator pads",
    description: "Fit new adult electrode pads before the expiry date printed on the pads packet. Pads are single use: replace them straight away after the defibrillator has been used. When you mark this done, enter the expiry date of the new pads.",
  },
  defib_battery: {
    label: "Battery",
    title: "Replace defibrillator battery",
    description: "Fit a new battery before the date on the battery (or as the defibrillator's status light or self-test asks). When you mark this done, enter the date the new battery must be replaced by.",
  },
  defib_child_pads: {
    label: "Child pads",
    title: "Replace defibrillator child pads",
    description: "Fit new child (paediatric) pads, or a new child key or cartridge, before the expiry date printed on the packet. When you mark this done, enter the expiry date of the new ones.",
  },
  ppe_examination: {
    label: "Thorough examination",
    title: "PPE thorough examination",
    description: "A competent person thoroughly examines this PPE and records the result. Harnesses, lanyards and other fall-arrest kit need one at least every six months (LOLER 1998 reg 9, Work at Height Regulations 2005); reusable respirators need one at the intervals the COSHH or maker's guidance sets. Take it out of use if it fails. When you mark this done, enter the date the next examination is due.",
  },
  rpe_filters: {
    label: "Filters",
    title: "Replace respirator filters",
    description: "Fit new filters or cartridges before the replace-by date (the date on the pack, or sooner if breathing gets harder or the wearer can smell or taste the substance). When you mark this done, enter the date the new filters must be replaced by.",
  },
  ppe_replace_by: {
    label: "Replace by",
    title: "Replace PPE (end of life)",
    description: "Take this PPE out of use and replace it by the maker's replace-by or end-of-life date (printed inside a hard hat, or on a harness or lanyard label), or straight away if it is damaged or has arrested a fall. When you mark this done, enter the replace-by date of the new one.",
  },
};

export function partsForType(type: string): readonly EquipmentPart[] {
  return EQUIPMENT_TYPE_PARTS[type as EquipmentType] ?? [];
}

export function partTitle(part: EquipmentPart, itemName: string): string {
  return `${EQUIPMENT_PART_INFO[part].title} — ${itemName}`;
}

export type PartState = {
  part: EquipmentPart;
  label: string;
  checkId: number;
  expiryDate: string | null;
  status: string;
  lastReplaced: string | null;
};

export type PartsSummary = {
  parts: PartState[];
  assigneeUserId: number | null;
  assigneeName: string | null;
};

const day = (value: unknown): string | null => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

/** The part checks of the given items, by item id. */
export async function partSummaries(clientId: number, equipmentIds: number[]): Promise<Map<number, PartsSummary>> {
  const map = new Map<number, PartsSummary>();
  if (!equipmentIds.length) return map;
  const rows = rowsOf(await db.execute(sql`
    SELECT id, equipment_id, equipment_part, due_date, status, completed_at, assignee_user_id, assigned_to
    FROM compliance_items
    WHERE client_id = ${clientId} AND equipment_part IS NOT NULL
      AND equipment_id IN (${sql.join(equipmentIds.map(id => sql`${id}`), sql`, `)})`));
  for (const row of rows) {
    const part = row.equipment_part as EquipmentPart;
    if (!EQUIPMENT_PART_INFO[part]) continue;
    const id = Number(row.equipment_id);
    const summary = map.get(id) ?? { parts: [], assigneeUserId: null, assigneeName: null };
    summary.parts.push({
      part, label: EQUIPMENT_PART_INFO[part].label, checkId: Number(row.id),
      expiryDate: row.status === "completed" ? null : day(row.due_date),
      status: String(row.status), lastReplaced: day(row.completed_at),
    });
    if (summary.assigneeUserId == null && summary.assigneeName == null) {
      summary.assigneeUserId = row.assignee_user_id == null ? null : Number(row.assignee_user_id);
      summary.assigneeName = row.assigned_to ?? null;
    }
    map.set(id, summary);
  }
  for (const summary of map.values()) {
    const order = Object.keys(EQUIPMENT_PART_INFO);
    summary.parts.sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part));
  }
  return map;
}

export type PartsInput = {
  /** Expiry date (YYYY-MM-DD) per part; null clears it; absent leaves it. */
  dates: Partial<Record<EquipmentPart, string | null>>;
  /** The person who replaces the parts; undefined leaves it as it is. */
  assigneeUserId?: number | null;
};

/**
 * Keep the item's part checks in step with the dates given and the item's
 * name and site. Returns an error message for a refused assignee.
 */
export async function syncPartChecks(req: Request, clientId: number, item: Row, input: PartsInput): Promise<string | null> {
  const equipmentId = Number(item.id);
  const siteId = item.site_id == null ? null : Number(item.site_id);
  const allowed = partsForType(String(item.type));
  const existing = rowsOf(await db.execute(sql`
    SELECT * FROM compliance_items
    WHERE client_id = ${clientId} AND equipment_id = ${equipmentId} AND equipment_part IS NOT NULL`));
  const byPart = new Map(existing.map(row => [row.equipment_part as EquipmentPart, row]));

  let assignee: { assigneeUserId?: number | null; name?: string | null } = {};
  if (input.assigneeUserId !== undefined) {
    const change = await resolveAssigneeChange(clientId, siteId, { assigneeUserId: input.assigneeUserId });
    if (!change.ok) return change.error;
    assignee = { assigneeUserId: change.assigneeUserId ?? null, name: change.name ?? null };
  }

  for (const part of allowed) {
    const row = byPart.get(part);
    const date = input.dates[part];
    if (date === undefined) {
      // Keep its title, site and person in step with the item.
      if (row) {
        await db.execute(sql`
          UPDATE compliance_items SET title = ${partTitle(part, item.name)}, site_id = ${siteId},
            ${assignee.assigneeUserId !== undefined ? sql`assignee_user_id = ${assignee.assigneeUserId}, assigned_to = ${assignee.name ?? null},` : sql``}
            updated_at = now()
          WHERE id = ${row.id} AND client_id = ${clientId}`);
      }
      continue;
    }
    if (date === null) {
      if (!row) continue;
      // A part the item no longer has (no child pads, say). A check never done
      // goes; one with a replacement on record stays as history, unlinked from the part.
      const [{ certs }] = rowsOf(await db.execute(sql`SELECT count(*)::int AS certs FROM certificates WHERE item_id = ${row.id}`));
      if (!row.completed_at && !certs) {
        await db.execute(sql`DELETE FROM compliance_items WHERE id = ${row.id} AND client_id = ${clientId}`);
        await appendAuditEvent(req, { clientId, entityType: "compliance_item", entityId: Number(row.id), action: "deleted", before: row, metadata: { equipmentPartCleared: part } });
      } else {
        await db.execute(sql`
          UPDATE compliance_items SET equipment_part = NULL, status = 'completed', updated_at = now()
          WHERE id = ${row.id} AND client_id = ${clientId}`);
        await appendAuditEvent(req, { clientId, entityType: "compliance_item", entityId: Number(row.id), action: "updated", before: row, metadata: { equipmentPartCleared: part } });
      }
      continue;
    }
    const dueDate = new Date(`${date}T00:00:00Z`);
    if (row) {
      const changed = day(row.due_date) !== date || row.status === "completed";
      const [after] = rowsOf(await db.execute(sql`
        UPDATE compliance_items SET title = ${partTitle(part, item.name)}, site_id = ${siteId},
          ${changed ? sql`due_date = ${dueDate}, status = 'pending', notification_sent_at = NULL,` : sql``}
          ${assignee.assigneeUserId !== undefined ? sql`assignee_user_id = ${assignee.assigneeUserId}, assigned_to = ${assignee.name ?? null},` : sql``}
          updated_at = now()
        WHERE id = ${row.id} AND client_id = ${clientId}
        RETURNING *`));
      if (changed) {
        await appendAuditEvent(req, { clientId, entityType: "compliance_item", entityId: Number(row.id), action: "updated", before: row, after, metadata: { equipmentPart: part, expiryDate: date } });
      }
      continue;
    }
    // A new part goes to the same person as the item's other parts.
    const sibling = existing.find(other => other.assignee_user_id != null || other.assigned_to != null);
    const people = assignee.assigneeUserId !== undefined
      ? assignee
      : { assigneeUserId: sibling?.assignee_user_id ?? null, name: sibling?.assigned_to ?? null };
    const [created] = rowsOf(await db.execute(sql`
      INSERT INTO compliance_items (client_id, site_id, title, description, status, priority, due_date, lead_time_days,
        equipment_id, equipment_part, assignee_user_id, assigned_to)
      VALUES (${clientId}, ${siteId}, ${partTitle(part, item.name)}, ${EQUIPMENT_PART_INFO[part].description}, 'pending', 'high',
        ${dueDate}, 30, ${equipmentId}, ${part}, ${people.assigneeUserId ?? null}, ${people.name ?? null})
      RETURNING *`));
    await appendAuditEvent(req, { clientId, entityType: "compliance_item", entityId: Number(created.id), action: "created", after: created, metadata: { equipmentPart: part, expiryDate: date } });
  }
  return null;
}
