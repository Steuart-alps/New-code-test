// Pure helpers for the read-only FireTrack / LegionellaTrack site controls
// screen. Kept free of React Native imports so tests can run them directly.

export type ControlModule = 'fire' | 'water';

export interface TemperatureLimit {
  min?: number;
  max?: number;
}

export interface ControlStatusRow {
  checkType: string;
  frequencyDays: number | null;
  lastDate?: string | null;
  lastResult?: string | null;
  dueDate?: string | null;
  status: string;
}

export interface ControlHistoryRow {
  id: number;
  checkType: string;
  checkDate: string;
  result: string;
  temperature?: string | number | null;
  performedBy?: string | null;
  location?: string | null;
  notes?: string | null;
}

export interface ControlField {
  key: string;
  label: string;
  value: string | null;
  kind: 'text' | 'date';
  /** Needed before an inspection; counted in the readiness summary. */
  required: boolean;
}

export interface MonitoringPlan {
  approved: boolean;
  profile: Record<string, unknown>;
}

export const FIRE_CHECK_LABELS: Record<string, string> = {
  alarm: 'Fire alarm test',
  alarm_panel: 'Alarm panel check',
  emergency_lights: 'Emergency lighting',
  extinguishers: 'Extinguisher check',
  fire_doors: 'Fire doors',
  fire_walk: 'Fire walk (escape routes)',
  fire_drill: 'Fire drill',
};

export const WATER_CHECK_LABELS: Record<string, string> = {
  calorifier_temp: 'Calorifier temperature',
  hot_sentinel_temp: 'Hot sentinel outlet temp',
  hot_nonsent_temp: 'Hot representative outlet temp',
  cold_tank_temp: 'Cold water storage temp',
  cold_sentinel_temp: 'Cold sentinel outlet temp',
  cold_nonsent_temp: 'Cold representative outlet temp',
  cold_tank_inspection: 'Cold water tank inspection',
  cold_tank_clean: 'Cold water tank clean & disinfect',
  calorifier_inspection: 'Calorifier inspection',
  calorifier_clean: 'Calorifier clean & disinfect',
  shower_clean: 'Shower head / hose descale',
  tmv_service: 'TMV service & verify',
  outlet_flush: 'Little-used outlet flush',
};

const UK_NATIONS: Record<string, string> = {
  england: 'England',
  scotland: 'Scotland',
  wales: 'Wales',
  northern_ireland: 'Northern Ireland',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const MS_DAY = 24 * 60 * 60 * 1000;
/** A review date this close is flagged so it can be booked before an inspection. */
export const REVIEW_DUE_SOON_DAYS = 30;

export function parseControlModule(value: unknown): ControlModule | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'fire' || raw === 'water' ? raw : null;
}

export function parseSiteParam(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Use the requested site when this user can see it, otherwise their first site. */
export function initialControlsSite(
  sites: { id: number }[] | undefined,
  requested: number | null,
): number | null {
  if (!sites?.length) return null;
  if (requested !== null && sites.some((site) => site.id === requested)) return requested;
  return sites[0].id;
}

export function checkLabel(module: ControlModule, checkType: string): string {
  const labels = module === 'fire' ? FIRE_CHECK_LABELS : WATER_CHECK_LABELS;
  return labels[checkType] ?? checkType.replace(/_/g, ' ');
}

export function formatControlDate(value: string | null | undefined): string {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  if (!match) return '—';
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : '—';
}

export function cadenceLabel(frequencyDays: number | null | undefined): string {
  if (frequencyDays == null || !Number.isInteger(frequencyDays) || frequencyDays < 1) {
    return 'No approved frequency';
  }
  const named: Record<number, string> = {
    1: 'Daily', 7: 'Weekly', 14: 'Fortnightly', 30: 'Monthly', 31: 'Monthly',
    90: 'Quarterly', 91: 'Quarterly', 92: 'Quarterly', 182: 'Six-monthly', 183: 'Six-monthly',
    365: 'Annually', 366: 'Annually',
  };
  const days = `every ${frequencyDays} day${frequencyDays === 1 ? '' : 's'}`;
  return named[frequencyDays] ? `${named[frequencyDays]} (${days})` : days[0].toUpperCase() + days.slice(1);
}

export function temperatureLimitLabel(limit: TemperatureLimit | null | undefined): string | null {
  if (!limit) return null;
  const min = typeof limit.min === 'number' && Number.isFinite(limit.min) ? limit.min : undefined;
  const max = typeof limit.max === 'number' && Number.isFinite(limit.max) ? limit.max : undefined;
  if (min !== undefined && max !== undefined) return `${min}–${max}°C`;
  if (min !== undefined) return `At least ${min}°C`;
  if (max !== undefined) return `At most ${max}°C`;
  return null;
}

function text(profile: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = profile?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nation(profile: Record<string, unknown> | null | undefined): string | null {
  const value = text(profile, 'ukNation');
  return value ? UK_NATIONS[value] ?? value : null;
}

export function fireControlFields(profile: Record<string, unknown> | null | undefined): ControlField[] {
  return [
    { key: 'riskAssessmentReference', label: 'Fire risk assessment', value: text(profile, 'riskAssessmentReference'), kind: 'text', required: true },
    { key: 'riskAssessmentDate', label: 'Assessment date', value: text(profile, 'riskAssessmentDate'), kind: 'date', required: true },
    { key: 'nextReviewDate', label: 'Next review date', value: text(profile, 'nextReviewDate'), kind: 'date', required: true },
    { key: 'responsiblePerson', label: 'Responsible person', value: text(profile, 'responsiblePerson'), kind: 'text', required: true },
    { key: 'maintenanceEvidenceReference', label: 'Maintenance evidence', value: text(profile, 'maintenanceEvidenceReference'), kind: 'text', required: true },
    { key: 'evacuationPeepArrangements', label: 'Evacuation / PEEP arrangements', value: text(profile, 'evacuationPeepArrangements'), kind: 'text', required: false },
    { key: 'defectClosureVerification', label: 'Defect closure verification', value: text(profile, 'defectClosureVerification'), kind: 'text', required: false },
    { key: 'ukNation', label: 'UK nation', value: nation(profile), kind: 'text', required: false },
  ];
}

export function waterControlFields(
  profile: Record<string, unknown> | null | undefined,
  plan?: MonitoringPlan | null,
): ControlField[] {
  const planProfile = plan?.profile ?? null;
  return [
    { key: 'writtenControlSchemeReference', label: 'Written control scheme', value: text(profile, 'writtenControlSchemeReference', 'writtenSchemeReference') ?? text(planProfile, 'writtenSchemeReference'), kind: 'text', required: true },
    { key: 'riskAssessmentReference', label: 'Legionella risk assessment', value: text(profile, 'riskAssessmentReference') ?? text(planProfile, 'riskAssessmentReference'), kind: 'text', required: true },
    { key: 'riskAssessmentReviewDate', label: 'Risk assessment review date', value: text(profile, 'riskAssessmentReviewDate'), kind: 'date', required: true },
    { key: 'schemeReviewDate', label: 'Scheme review date', value: text(profile, 'schemeReviewDate'), kind: 'date', required: false },
    { key: 'competentPerson', label: 'Responsible / competent person', value: text(profile, 'competentPerson') ?? text(planProfile, 'competentPerson'), kind: 'text', required: true },
    { key: 'systemInventoryReference', label: 'Water-system inventory', value: text(profile, 'systemInventoryReference'), kind: 'text', required: false },
    { key: 'samplingLabRecordReference', label: 'Sampling and lab records', value: text(profile, 'samplingLabRecordReference'), kind: 'text', required: false },
    { key: 'remedialVerificationReference', label: 'Remedial verification', value: text(profile, 'remedialVerificationReference'), kind: 'text', required: false },
    { key: 'controlLimitsRationale', label: 'Control limits rationale', value: text(profile, 'controlLimitsRationale'), kind: 'text', required: false },
    { key: 'ukNation', label: 'UK nation', value: nation(profile), kind: 'text', required: false },
  ];
}

export type ReviewDateState = 'missing' | 'overdue' | 'due_soon' | 'ok';

export function reviewDateState(value: string | null | undefined, todayIso: string): ReviewDateState {
  const date = typeof value === 'string' ? ISO_DATE.exec(value)?.[0] : undefined;
  const today = ISO_DATE.exec(todayIso)?.[0];
  if (!date || !today) return 'missing';
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_DAY);
  if (days < 0) return 'overdue';
  return days <= REVIEW_DUE_SOON_DAYS ? 'due_soon' : 'ok';
}

export type PlanState = 'approved' | 'review_required' | 'not_approved';

export function monitoringPlanState(plan: MonitoringPlan | null | undefined): PlanState {
  if (plan?.approved) return 'approved';
  return plan?.profile?.reviewRequired === true ? 'review_required' : 'not_approved';
}

export interface ReadinessSummary {
  recorded: number;
  total: number;
  missing: string[];
  overdueReviews: string[];
  ready: boolean;
}

/**
 * What an inspector would ask for first: every required reference recorded,
 * no review date in the past and, for LegionellaTrack, an approved plan.
 */
export function controlsReadiness(
  fields: ControlField[],
  todayIso: string,
  plan?: PlanState,
): ReadinessSummary {
  const required = fields.filter((field) => field.required);
  const missing = required.filter((field) => !field.value).map((field) => field.label);
  const overdueReviews = fields
    .filter((field) => field.kind === 'date' && /review/i.test(field.label)
      && reviewDateState(field.value, todayIso) === 'overdue')
    .map((field) => field.label);
  if (plan !== undefined && plan !== 'approved') missing.push('Approved monitoring plan');
  const total = required.length + (plan === undefined ? 0 : 1);
  return {
    recorded: total - missing.length,
    total,
    missing,
    overdueReviews,
    ready: missing.length === 0 && overdueReviews.length === 0,
  };
}

/** Most recent checks per type, newest first, so each row shows its own history. */
export function historyByCheckType<T extends ControlHistoryRow>(rows: T[] | undefined, perType = 3): Map<string, T[]> {
  const sorted = [...(rows ?? [])].sort((a, b) =>
    a.checkDate === b.checkDate ? b.id - a.id : a.checkDate < b.checkDate ? 1 : -1);
  const grouped = new Map<string, T[]>();
  for (const row of sorted) {
    const list = grouped.get(row.checkType) ?? [];
    if (list.length < perType) list.push(row);
    grouped.set(row.checkType, list);
  }
  return grouped;
}

export function temperatureText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed}°C` : null;
}

export function localIsoDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
