/**
 * Actions on the phone (app/manage/actions.tsx and app/manage/action.tsx):
 *
 * - Module actions: corrective actions raised from each track
 *   (api-server routes/track-actions.ts), shown on the website in every
 *   track's "Module actions" panel (components/module-actions-panel.tsx).
 * - Corrective actions: the Compliance Hub's action log
 *   (routes/compliance-hub.ts, pages/compliance-hub.tsx).
 *
 * Role rules mirror the website and API exactly: viewers read only; KitchenTrack
 * module actions are managed by client admins and consultants; only a
 * different client admin or consultant may verify a corrective action closed.
 * Rows are read tolerantly (extra fields are ignored) so newer API versions
 * keep working.
 *
 * Import-free so tests can load it directly with Node.
 */

export interface ModuleAction {
  id: number;
  module: string;
  title: string;
  severity: string;
  status: string;
  siteId?: number | null;
  ownerName?: string | null;
  dueDate?: string | null;
  instruction?: string | null;
  instructionSnapshot?: string | null;
  sourceKind?: string | null;
  sourceRecordId?: number | null;
  fixTrackIssueId?: number | null;
  fixTrackDisposition?: string | null;
  provenance?: string | null;
  templateId?: number | null;
  remedialAction?: string | null;
  evidenceReference?: string | null;
  resolutionNotes?: string | null;
  createdAt?: string | null;
}

export interface HubAction {
  id: number;
  sourceTrack: string;
  sourceRecordId?: string | null;
  title: string;
  severity: string;
  status: string;
  ownerName?: string | null;
  dueDate?: string | null;
  interimControl?: string | null;
  correctiveAction?: string | null;
  evidenceReference?: string | null;
  verificationNotes?: string | null;
  createdAt?: string | null;
}

export interface SiteOption { id: number; name: string }

export function sitesFrom(data: unknown): SiteOption[] {
  const list = Array.isArray(data) ? data
    : data && typeof data === 'object' && Array.isArray((data as { sites?: unknown }).sites)
      ? (data as { sites: unknown[] }).sites : [];
  return list.filter((row): row is SiteOption => !!row && typeof row === 'object'
    && Number.isInteger((row as SiteOption).id) && typeof (row as SiteOption).name === 'string');
}

/** Same names as the API's track summary (lib/trackActionReminders.ts). */
export const MODULE_LABELS: Record<string, string> = {
  daily_am: 'DailyTrack AM',
  daily_pm: 'DailyTrack PM',
  kitchen: 'KitchenTrack',
  fire: 'FireTrack',
  legionella: 'LegionellaTrack',
  pool: 'AquaTrack',
  pat: 'PATtrack',
  pest: 'PestTrack',
  fix: 'FixTrack',
  premises: 'PremisesTrack',
  doc: 'DocTrack',
  safe: 'SafeTrack',
  train: 'TrainTrack',
  hot_tub: 'TubTrack',
  tree: 'TreeTrack',
  bike: 'BikeTrack',
  green: 'GreenTrack',
  swim: 'SwimTrack',
  incident: 'IncidentTrack',
  room: 'RoomTrack',
};

export function moduleLabel(key: string): string {
  return MODULE_LABELS[key] ?? key.replace(/_/g, ' ');
}

export const MODULE_SEVERITIES = [
  { value: 'monitor', label: 'Monitor' },
  { value: 'action_required', label: 'Action required' },
  { value: 'urgent', label: 'Urgent' },
] as const;

export const HUB_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'awaiting_verification', label: 'Awaiting verification' },
  { value: 'verified', label: 'Verified closed' },
] as const;

/** "action_required" -> "Action required". */
export function humanise(value: string | null | undefined): string {
  const text = (value ?? '').replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

export function hubStatusLabel(status: string): string {
  return HUB_STATUSES.find((item) => item.value === status)?.label ?? humanise(status);
}

const isManager = (role: string | null | undefined) => role === 'client_admin' || role === 'consultant';

/** The date part of an API date, or null. */
export function dueDay(dueDate: string | null | undefined): string | null {
  const day = typeof dueDate === 'string' ? dueDate.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function isOverdue(dueDate: string | null | undefined, today: string): boolean {
  const day = dueDay(dueDate);
  return !!day && day < today;
}

export function formatDay(day: string | null | undefined): string {
  const iso = dueDay(day);
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

const SEVERITY_RANK: Record<string, number> = {
  urgent: 0, critical: 0, action_required: 1, high: 1, medium: 2, monitor: 3, low: 3,
};

/** Overdue first, then soonest due, then most severe, then newest. */
export function compareActions<T extends { id: number; dueDate?: string | null; severity: string }>(today: string) {
  return (a: T, b: T): number => {
    const ao = isOverdue(a.dueDate, today) ? 0 : 1;
    const bo = isOverdue(b.dueDate, today) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ad = dueDay(a.dueDate); const bd = dueDay(b.dueDate);
    if (ad !== bd) {
      if (!ad) return 1;
      if (!bd) return -1;
      return ad < bd ? -1 : 1;
    }
    const as = SEVERITY_RANK[a.severity] ?? 4; const bs = SEVERITY_RANK[b.severity] ?? 4;
    if (as !== bs) return as - bs;
    return b.id - a.id;
  };
}

export const ALL = 'all';
export interface ActionFilters {
  /** Module key (module actions) or source track (corrective actions), or ALL. */
  track: string;
  /** Site id as a string, or ALL. Module actions only. */
  site: string;
  overdueOnly: boolean;
}
export const DEFAULT_FILTERS: ActionFilters = { track: ALL, site: ALL, overdueOnly: false };

/**
 * A row with snake_case keys also readable by their camelCase names (camel
 * wins when both are present), so either response style parses.
 */
export function camelRow(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    if (camel !== key && camel in (row as Record<string, unknown>)) continue;
    out[camel] = value;
  }
  return out;
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data
    : data && typeof data === 'object' && Array.isArray((data as { actions?: unknown }).actions)
      ? (data as { actions: unknown[] }).actions : [];
  return list.map(camelRow).filter((row): row is Record<string, unknown> => row !== null);
}

/** Accept only well-formed rows; tolerate any extra fields. */
export function moduleActionsFrom(data: unknown): ModuleAction[] {
  return rowsOf(data).filter((row) => Number.isInteger(row.id) && typeof row.module === 'string'
    && typeof row.title === 'string' && typeof row.status === 'string') as unknown as ModuleAction[];
}

export function hubActionsFrom(data: unknown): HubAction[] {
  return rowsOf(data).filter((row) => Number.isInteger(row.id) && typeof row.title === 'string'
    && typeof row.status === 'string') as unknown as HubAction[];
}

/** Unresolved module actions matching the filters, most pressing first. */
export function filterModuleActions(actions: readonly ModuleAction[], filters: ActionFilters, today: string): ModuleAction[] {
  return actions
    .filter((action) => action.status !== 'resolved')
    .filter((action) => filters.track === ALL || action.module === filters.track)
    .filter((action) => filters.site === ALL || String(action.siteId ?? '') === filters.site)
    .filter((action) => !filters.overdueOnly || isOverdue(action.dueDate, today))
    .sort(compareActions<ModuleAction>(today));
}

/** Corrective actions not yet verified closed, matching the filters. */
export function filterHubActions(actions: readonly HubAction[], filters: ActionFilters, today: string): HubAction[] {
  return actions
    .filter((action) => action.status !== 'verified')
    .filter((action) => filters.track === ALL || action.sourceTrack === filters.track)
    .filter((action) => !filters.overdueOnly || isOverdue(action.dueDate, today))
    .sort(compareActions<HubAction>(today));
}

/** Filter choices: only modules and sites that have unresolved actions. */
export function moduleTrackOptions(actions: readonly ModuleAction[]): { value: string; label: string }[] {
  const keys = [...new Set(actions.filter((a) => a.status !== 'resolved').map((a) => a.module))];
  return keys.map((value) => ({ value, label: moduleLabel(value) })).sort((a, b) => a.label.localeCompare(b.label));
}

export function hubTrackOptions(actions: readonly HubAction[]): { value: string; label: string }[] {
  const keys = [...new Set(actions.filter((a) => a.status !== 'verified').map((a) => a.sourceTrack))];
  return keys.map((value) => ({ value, label: value })).sort((a, b) => a.label.localeCompare(b.label));
}

export function siteFilterOptions(actions: readonly ModuleAction[], sites: readonly SiteOption[]): { value: string; label: string }[] {
  const ids = new Set(actions.filter((a) => a.status !== 'resolved' && a.siteId != null).map((a) => a.siteId as number));
  return sites.filter((site) => ids.has(site.id)).map((site) => ({ value: String(site.id), label: site.name }));
}

/** A filter that no longer matches any option falls back to ALL. */
export function reconcileFilters(
  filters: ActionFilters,
  trackOptions: readonly { value: string }[],
  siteOptions: readonly { value: string }[],
): ActionFilters {
  const track = filters.track === ALL || trackOptions.some((o) => o.value === filters.track) ? filters.track : ALL;
  const site = filters.site === ALL || siteOptions.some((o) => o.value === filters.site) ? filters.site : ALL;
  return track === filters.track && site === filters.site ? filters : { ...filters, track, site };
}

// ---------------------------------------------------------------------------
// Module actions (track-actions)

export function isKitchenTemperatureAction(action: Pick<ModuleAction, 'module' | 'sourceKind'>): boolean {
  return action.module === 'kitchen' && !!action.sourceKind?.startsWith('kitchen_temperature_');
}

/**
 * Who may change a module action. Website: not a viewer, and KitchenTrack
 * actions only for client admins and consultants.
 */
export function canMutateModuleAction(role: string | null | undefined, action: Pick<ModuleAction, 'module' | 'status'>): boolean {
  if (!role || role === 'client_viewer') return false;
  if (action.status === 'resolved') return false;
  return action.module !== 'kitchen' || isManager(role);
}

export type FixTrackChoice =
  | { kind: 'none' }
  | { kind: 'linked'; issueId: number }
  | { kind: 'ask'; canDecline: boolean };

/** The website's FixTrack choice under each module action. */
export function fixTrackChoice(action: ModuleAction, canMutate: boolean): FixTrackChoice {
  if (action.module === 'green' || isKitchenTemperatureAction(action)) return { kind: 'none' };
  if (action.fixTrackIssueId) return { kind: 'linked', issueId: action.fixTrackIssueId };
  if (!canMutate || action.status === 'resolved') return { kind: 'none' };
  return { kind: 'ask', canDecline: action.fixTrackDisposition !== 'not_needed' };
}

export function fixTrackQuestion(choice: FixTrackChoice): string {
  if (choice.kind === 'linked') return `Linked to FixTrack issue #${choice.issueId}. Resolving it will complete this action.`;
  if (choice.kind === 'ask') {
    return choice.canDecline
      ? 'Does this action require FixTrack repair or contractor work?'
      : 'Kept in this track. Add it to FixTrack now?';
  }
  return '';
}

export function provenanceLabel(action: Pick<ModuleAction, 'provenance' | 'sourceKind' | 'templateId'>): string {
  if (action.provenance === 'product_default' || action.sourceKind) return 'Product default';
  if (action.provenance === 'template' || action.templateId) return 'Client template';
  return 'One-off';
}

export interface ModuleDetails {
  title: string;
  severity: string;
  /** Site id as a string, or '' for no site. */
  siteId: string;
  ownerName: string;
  dueDate: string;
}

export function detailsFromAction(action: ModuleAction): ModuleDetails {
  return {
    title: action.title,
    severity: action.severity,
    siteId: action.siteId ? String(action.siteId) : '',
    ownerName: action.ownerName ?? '',
    dueDate: dueDay(action.dueDate) ?? '',
  };
}

/**
 * Fields the API will not change: the source record controls the site of an
 * action it raised, and a failed temperature's title and severity are fixed.
 */
export function lockedDetails(action: ModuleAction): { site: boolean; titleAndSeverity: boolean } {
  return { site: !!action.sourceKind, titleAndSeverity: isKitchenTemperatureAction(action) };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The PATCH body for "Save details": only the fields that changed (the
 * website sends every field, which the API refuses for locked ones).
 */
export function buildDetailsPatch(
  action: ModuleAction,
  details: ModuleDetails,
): { ok: true; patch: Record<string, unknown> } | { ok: false; message: string } {
  const title = details.title.trim();
  if (!title) return { ok: false, message: 'Enter an action title.' };
  if (title.length > 500) return { ok: false, message: 'The title must be 500 characters or fewer.' };
  const dueDate = details.dueDate.trim();
  if (dueDate && !validDate(dueDate)) return { ok: false, message: 'Enter the due date as YYYY-MM-DD, or leave it blank.' };
  const before = detailsFromAction(action);
  const locks = lockedDetails(action);
  const patch: Record<string, unknown> = {};
  if (!locks.titleAndSeverity && title !== before.title) patch.title = title;
  if (!locks.titleAndSeverity && details.severity !== before.severity) patch.severity = details.severity;
  if (!locks.site && details.siteId !== before.siteId) patch.siteId = details.siteId ? Number(details.siteId) : null;
  if (details.ownerName.trim() !== before.ownerName.trim()) patch.ownerName = details.ownerName.trim() || null;
  if (dueDate !== before.dueDate) patch.dueDate = dueDate || null;
  if (!Object.keys(patch).length) return { ok: false, message: 'Nothing has changed.' };
  return { ok: true, patch };
}

export interface ResolutionValues { remedialAction: string; evidenceReference: string; resolutionNotes: string }
export const EMPTY_RESOLUTION: ResolutionValues = { remedialAction: '', evidenceReference: '', resolutionNotes: '' };

/** Why the action cannot be resolved on this form, or null. */
export function resolutionBlocker(action: ModuleAction): string | null {
  if (action.fixTrackIssueId) return `Complete this action in FixTrack: resolve FixTrack issue #${action.fixTrackIssueId} to update this module automatically.`;
  return null;
}

export function resolutionReady(values: ResolutionValues): boolean {
  return !!(values.remedialAction.trim() && values.evidenceReference.trim() && values.resolutionNotes.trim());
}

/** The website's final sign-off: three fields and a drawn signature. */
export function buildResolutionPatch(values: ResolutionValues, resolverSignature: string | null): { ok: true; patch: Record<string, unknown> } | { ok: false; message: string } {
  if (!resolutionReady(values)) return { ok: false, message: 'Remedial action, evidence reference and resolution notes are required to resolve an action.' };
  if (!resolverSignature || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(resolverSignature)) {
    return { ok: false, message: 'Draw your signature to confirm that you completed and signed off this action.' };
  }
  return {
    ok: true,
    patch: {
      status: 'resolved',
      remedialAction: values.remedialAction.trim(),
      evidenceReference: values.evidenceReference.trim(),
      resolutionNotes: values.resolutionNotes.trim(),
      resolverSignature,
    },
  };
}

// ---------------------------------------------------------------------------
// Corrective actions (compliance-hub)

/** Website: anyone but a viewer may update an action until it is verified. */
export function canEditHubAction(role: string | null | undefined, action: Pick<HubAction, 'status'>): boolean {
  return !!role && role !== 'client_viewer' && action.status !== 'verified';
}

/**
 * Status choices. "Verified closed" is offered only from "Awaiting
 * verification" and only to client admins and consultants; the API also
 * refuses the person who logged the action.
 */
export function hubStatusOptions(role: string | null | undefined, current: string): { value: string; label: string }[] {
  return HUB_STATUSES
    .filter((item) => item.value !== 'verified' || (current === 'awaiting_verification' && isManager(role)))
    .map((item) => ({ value: item.value, label: item.label }));
}

export interface HubUpdate { status: string; evidenceReference: string; verificationNotes: string }

export function hubUpdateFrom(action: HubAction): HubUpdate {
  return { status: action.status, evidenceReference: action.evidenceReference ?? '', verificationNotes: action.verificationNotes ?? '' };
}

export function buildHubPatch(update: HubUpdate): { ok: true; patch: Record<string, unknown> } | { ok: false; message: string } {
  if (!HUB_STATUSES.some((item) => item.value === update.status)) return { ok: false, message: 'Choose an action status.' };
  const evidenceReference = update.evidenceReference.trim();
  const verificationNotes = update.verificationNotes.trim();
  if (evidenceReference.length > 1000) return { ok: false, message: 'The evidence reference must be 1000 characters or fewer.' };
  if (verificationNotes.length > 4000) return { ok: false, message: 'Verification notes must be 4000 characters or fewer.' };
  if (update.status === 'verified' && (!evidenceReference || !verificationNotes)) {
    return { ok: false, message: 'Evidence reference and verification notes are required before an action can be verified closed.' };
  }
  return { ok: true, patch: { status: update.status, evidenceReference, verificationNotes } };
}

// ---------------------------------------------------------------------------

export interface ActionCounts { open: number; overdue: number }

export function countModuleActions(actions: readonly ModuleAction[], today: string): ActionCounts {
  const open = actions.filter((a) => a.status !== 'resolved');
  return { open: open.length, overdue: open.filter((a) => isOverdue(a.dueDate, today)).length };
}

export function countHubActions(actions: readonly HubAction[], today: string): ActionCounts {
  const open = actions.filter((a) => a.status !== 'verified');
  return { open: open.length, overdue: open.filter((a) => isOverdue(a.dueDate, today)).length };
}
