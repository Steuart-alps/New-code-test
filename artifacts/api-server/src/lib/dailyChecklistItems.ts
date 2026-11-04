import { z } from 'zod';
import { db } from '@workspace/db';
import { auditEventsTable, trackActionsTable } from '@workspace/db/schema';
import { sql } from 'drizzle-orm';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const checklistItemSchema = z.object({
  label: z.string(),
  checked: z.boolean(),
  notes: z.string().optional(),
  section: z.string().optional(),
  result: z.enum(['pass', 'fail', 'na']).optional(),
});

export type ChecklistItem = z.infer<typeof checklistItemSchema>;

/** Older checklists only stored a tick: a ticked item counts as a pass. */
function itemResult(item: Partial<ChecklistItem>) {
  return item.result ?? (item.checked ? 'pass' : undefined);
}

/** `checked` stays in step with the answer so older readers count fails as not done. */
export function normaliseChecklistItems(items: ChecklistItem[]): ChecklistItem[] {
  return items.map(item => item.result ? { ...item, checked: item.result !== 'fail' } : item);
}

/**
 * A checklist can be submitted only when every item is answered Pass, Fail
 * or N/A and every failed item says what is wrong. Returns the reason it
 * cannot, or null.
 */
export function checklistIncompleteReason(items: unknown): string | null {
  const list = Array.isArray(items) ? items as Partial<ChecklistItem>[] : [];
  if (list.length === 0) return 'Add at least one item before submitting.';
  const unanswered = list.filter(item => !itemResult(item)).length;
  if (unanswered) return `Answer every item Pass, Fail or N/A before submitting (${unanswered} left).`;
  const missingNotes = list.filter(item => itemResult(item) === 'fail' && !item.notes?.trim()).length;
  if (missingNotes) return `Say what is wrong for each failed item before submitting (${missingNotes} left).`;
  return null;
}

const CHECKLIST_NAMES: Record<string, string> = {
  kitchen_opening: 'Kitchen opening checks',
  kitchen_closing: 'Kitchen closing checks',
  premises_opening: 'Premises opening checks',
  premises_closing: 'Premises closing checks',
  greenkeeping_opening: 'Greenkeeping shed opening checks',
  greenkeeping_closing: 'Greenkeeping shed closing checks',
};

export function moduleFor(checklistType: string) {
  if (checklistType.startsWith('kitchen_')) return 'kitchen';
  if (checklistType.startsWith('greenkeeping_')) return 'green';
  return checklistType.endsWith('_opening') ? 'daily_am' : 'daily_pm';
}

type FailedItemSource = {
  clientId: number; siteId: number | null; module: string; sourceKindPrefix: string; sourceRecordId: number;
  checklistName: string; checkDate: string; completedBy: string | null;
  items: { label?: string; checked?: boolean; result?: string; notes?: string }[];
};

/**
 * Each failed item on a submitted checklist becomes an open action on that
 * track (and so a FixTrack job, via the track_actions trigger). Keyed by item
 * index so a retry never adds a second action for the same item.
 */
export async function createFailedItemActions(tx: Tx, source: FailedItemSource, actorId: number) {
  for (const [index, item] of source.items.entries()) {
    if (itemResult(item as Partial<ChecklistItem>) !== 'fail') continue;
    const inserted = await tx.insert(trackActionsTable).values({
      clientId: source.clientId,
      siteId: source.siteId,
      module: source.module,
      sourceKind: `${source.sourceKindPrefix}:${index}`,
      sourceRecordId: source.sourceRecordId,
      provenance: 'product_default',
      severity: 'action_required',
      status: 'open',
      title: `Failed check: ${item.label ?? 'Checklist item'}`,
      instruction: `${source.checklistName} on ${source.checkDate}${source.completedBy ? `, completed by ${source.completedBy}` : ''}. `
        + `Item failed: ${item.label ?? ''}. What was wrong: ${item.notes?.trim() ?? ''}`,
      dueDate: sql`((now() AT TIME ZONE 'Europe/London')::date + 1)` as any,
      createdBy: actorId,
    }).onConflictDoNothing().returning();
    const action = inserted[0];
    if (!action) continue;
    await tx.insert(auditEventsTable).values({
      clientId: source.clientId, actorId, entityType: 'track_action', entityId: action.id,
      action: 'checklist_item_failed', after: action,
      metadata: { sourceKind: source.sourceKindPrefix, sourceRecordId: source.sourceRecordId, itemIndex: index },
    });
  }
}

export function createFailedChecklistItemActions(tx: Tx, checklist: {
  id: number; clientId: number; siteId: number | null; checklistType: string; checkDate: string;
  items: unknown; completedBy: string | null;
}, actorId: number) {
  return createFailedItemActions(tx, {
    clientId: checklist.clientId, siteId: checklist.siteId, module: moduleFor(checklist.checklistType),
    sourceKindPrefix: 'daily_checklist_item', sourceRecordId: checklist.id,
    checklistName: CHECKLIST_NAMES[checklist.checklistType] ?? 'Daily checks',
    checkDate: checklist.checkDate, completedBy: checklist.completedBy,
    items: Array.isArray(checklist.items) ? checklist.items : [],
  }, actorId);
}
