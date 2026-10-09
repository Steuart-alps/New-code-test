import type { CleaningFrequency } from './cleaning-schedule-logic';

export interface CleaningDraftCompletion {
  taskId?: number;
  taskArea?: string;
  taskName: string;
  done: boolean;
  doneBy?: string;
  notes?: string;
}

export interface CleaningDraftLog {
  completions?: CleaningDraftCompletion[] | null;
  signed_by?: string | null;
}

export interface CleaningDraftTask {
  id: number;
  area: string;
  task: string;
}

export interface HydratedCleaningDraft {
  checked: Record<number, boolean>;
  doneBy: Record<number, string>;
  initials: string;
}

export type CleaningFrequencyChange =
  | { kind: 'ignore' }
  | { kind: 'confirm'; frequency: CleaningFrequency }
  | { kind: 'switch'; frequency: CleaningFrequency };

export type CleaningSiteChange =
  | { kind: 'ignore' }
  | { kind: 'confirm'; siteId: number }
  | { kind: 'switch'; siteId: number };

export interface CleaningLogPayload {
  logDate: string;
  frequency: CleaningFrequency;
  siteId: number | null;
  completions: CleaningDraftCompletion[];
  signedBy: string;
  submittedAt: string | null;
}

/**
 * Returns null for dirty forms so a background query refresh cannot replace
 * edits that have not been saved yet.
 */
export function hydrateCleaningDraft(
  log: CleaningDraftLog | null | undefined,
  userName: string | undefined,
  isDirty: boolean,
): HydratedCleaningDraft | null {
  if (isDirty) return null;

  const checked: Record<number, boolean> = {};
  const doneBy: Record<number, string> = {};
  for (const completion of log?.completions ?? []) {
    if (typeof completion.taskId !== 'number') continue;
    checked[completion.taskId] = !!completion.done;
    if (completion.doneBy) doneBy[completion.taskId] = completion.doneBy;
  }

  return {
    checked,
    doneBy,
    initials: log?.signed_by ?? userName ?? '',
  };
}

export function requestCleaningFrequencyChange(
  currentFrequency: CleaningFrequency,
  nextFrequency: CleaningFrequency,
  isDirty: boolean,
  isSaving: boolean,
): CleaningFrequencyChange {
  if (currentFrequency === nextFrequency || isSaving) return { kind: 'ignore' };
  if (isDirty) return { kind: 'confirm', frequency: nextFrequency };
  return { kind: 'switch', frequency: nextFrequency };
}

export function requestCleaningSiteChange(
  currentSiteId: number | null,
  nextSiteId: number,
  isDirty: boolean,
  isSaving: boolean,
): CleaningSiteChange {
  if (currentSiteId === nextSiteId || isSaving) return { kind: 'ignore' };
  if (isDirty) return { kind: 'confirm', siteId: nextSiteId };
  return { kind: 'switch', siteId: nextSiteId };
}

export function buildCleaningLogPayload(options: {
  logDate: string;
  frequency: CleaningFrequency;
  siteId?: number | null;
  tasks: CleaningDraftTask[];
  checked: Record<number, boolean>;
  doneBy: Record<number, string>;
  staffName: string;
  submit: boolean;
  submittedAt?: string;
}): CleaningLogPayload {
  const staffName = options.staffName.trim();
  const completions = options.tasks.map((task) => ({
    taskId: task.id,
    taskArea: task.area,
    taskName: task.task,
    done: !!options.checked[task.id],
    ...(options.checked[task.id]
      ? { doneBy: options.doneBy[task.id] ?? staffName }
      : {}),
  }));

  return {
    logDate: options.logDate,
    frequency: options.frequency,
    siteId: options.siteId ?? null,
    completions,
    signedBy: staffName,
    submittedAt: options.submit
      ? options.submittedAt ?? new Date().toISOString()
      : null,
  };
}