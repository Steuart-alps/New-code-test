/**
 * PestTrack on the phone: the website's pest activity and contractor visit
 * forms (compliance-tracker pages/pest-track.tsx), same fields and the same
 * payload shape for POST /api/pest-track/activity and /visits. Configuration,
 * edits and deletes stay on the website.
 *
 * Import-free so tests can load it directly with Node.
 */

export interface PestSite { id: number; name: string }

export interface PestActivity {
  id: number;
  site_id: number | null;
  recorded_date: string;
  pest_type: string;
  evidence_type: string;
  location: string | null;
  severity: string;
  action_taken: string | null;
  recorded_by: string | null;
  resolved: boolean;
  notes: string | null;
}

export interface PestVisit {
  id: number;
  site_id: number | null;
  visit_date: string;
  contractor_name: string | null;
  contractor_company: string | null;
  areas_inspected: string | null;
  findings: string | null;
  treatments_applied: string | null;
  recommendations: string | null;
  next_visit_date: string | null;
  signed_off_by: string | null;
  notes: string | null;
}

// Server defaults (api-server lib/formOptions.ts), used only until the
// account's own lists load; the server validates against the account's list.
export const DEFAULT_PEST_TYPES = ['rodent', 'insect', 'bird', 'other'] as const;
export const DEFAULT_PEST_EVIDENCE_TYPES = ['live_sighting', 'droppings', 'damage', 'nest', 'tracks', 'other'] as const;
export const PEST_SEVERITIES = ['low', 'medium', 'high'] as const;

const PEST_TYPE_LABELS: Record<string, string> = { rodent: 'Rodent', insect: 'Insect', bird: 'Bird', other: 'Other' };
const EVIDENCE_LABELS: Record<string, string> = {
  live_sighting: 'Live sighting', droppings: 'Droppings', damage: 'Damage',
  nest: 'Nest / harbourage', tracks: 'Tracks / smear marks', other: 'Other',
};
const SEVERITY_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export const pestTypeLabel = (value: string) => PEST_TYPE_LABELS[value] ?? value;
export const evidenceLabel = (value: string) => EVIDENCE_LABELS[value] ?? value;
export const severityLabel = (value: string) => SEVERITY_LABELS[value] ?? value;

/** The account's effective option list, or the server defaults until it loads. */
export function pestOptions(loaded: string[] | undefined, defaults: readonly string[]): string[] {
  return loaded?.length ? loaded : [...defaults];
}

export function localDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Site the record belongs to. With sites on the account one must be chosen;
 * an account without sites records against all sites (null), as on the web.
 */
export function pestSiteChoice(siteId: number | null, sites: PestSite[] | undefined):
  { ready: true; siteId: number | null } | { ready: false } {
  if (!sites) return { ready: false };
  if (sites.length === 0) return { ready: true, siteId: null };
  return siteId !== null && sites.some((site) => site.id === siteId) ? { ready: true, siteId } : { ready: false };
}

/** Records for the chosen site, plus those logged against all sites. */
export function pestRecordsForSite<T extends { site_id: number | null }>(rows: T[], siteId: number | null): T[] {
  return siteId === null ? rows : rows.filter((row) => row.site_id === siteId || row.site_id === null);
}

const text = (value: string) => value.trim() || null;

export interface PestActivityDraft {
  recordedDate: string;
  pestType: string;
  evidenceType: string;
  location: string;
  severity: string;
  actionTaken: string;
  recordedBy: string;
  resolved: boolean;
  notes: string;
}

export type PestPayloadResult = { ok: true; payload: Record<string, unknown> } | { ok: false; title: string; message: string };

export function buildPestActivityPayload(draft: PestActivityDraft, siteId: number | null): PestPayloadResult {
  if (!isCalendarDate(draft.recordedDate)) {
    return { ok: false, title: 'Check the date', message: 'Enter the date recorded as YYYY-MM-DD.' };
  }
  if (!draft.pestType || !draft.evidenceType || !(PEST_SEVERITIES as readonly string[]).includes(draft.severity)) {
    return { ok: false, title: 'Choose the details', message: 'Choose the pest type, evidence type and severity.' };
  }
  return {
    ok: true,
    payload: {
      recordedDate: draft.recordedDate,
      pestType: draft.pestType,
      evidenceType: draft.evidenceType,
      location: text(draft.location),
      severity: draft.severity,
      actionTaken: text(draft.actionTaken),
      recordedBy: text(draft.recordedBy),
      resolved: draft.resolved,
      notes: text(draft.notes),
      siteId,
    },
  };
}

export interface PestVisitDraft {
  visitDate: string;
  nextVisitDate: string;
  contractorName: string;
  contractorCompany: string;
  areasInspected: string;
  findings: string;
  treatmentsApplied: string;
  recommendations: string;
  signedOffBy: string;
  notes: string;
}

export function buildPestVisitPayload(draft: PestVisitDraft, siteId: number | null): PestPayloadResult {
  if (!isCalendarDate(draft.visitDate)) {
    return { ok: false, title: 'Check the date', message: 'Enter the visit date as YYYY-MM-DD.' };
  }
  const next = draft.nextVisitDate.trim();
  if (next && !isCalendarDate(next)) {
    return { ok: false, title: 'Check the next visit', message: 'Enter the next scheduled visit as YYYY-MM-DD, or leave it blank.' };
  }
  return {
    ok: true,
    payload: {
      visitDate: draft.visitDate,
      contractorName: text(draft.contractorName),
      contractorCompany: text(draft.contractorCompany),
      areasInspected: text(draft.areasInspected),
      findings: text(draft.findings),
      treatmentsApplied: text(draft.treatmentsApplied),
      recommendations: text(draft.recommendations),
      nextVisitDate: next || null,
      signedOffBy: text(draft.signedOffBy),
      notes: text(draft.notes),
      siteId,
    },
  };
}

/** Next scheduled visit as recorded on the most recent visit (as the web status card). */
export function nextPestVisit(visits: PestVisit[], today: string): { date: string; overdue: boolean } | null {
  const latest = [...visits].sort((a, b) => b.visit_date.localeCompare(a.visit_date))[0];
  const date = latest?.next_visit_date?.slice(0, 10);
  return date ? { date, overdue: date < today } : null;
}
