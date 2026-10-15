/**
 * Site registers on the phone (app/manage/allergens.tsx, coshh.tsx,
 * asbestos.tsx): read-only look-ups of the website's allergen records, COSHH
 * register and asbestos register (GET /api/registers/*). Labels and wording
 * mirror the website pages; adding, editing and removing stay on the website.
 *
 * The last list loaded is kept on the phone per account so it can be read
 * without signal. Import-free so tests can load it with Node.
 */

// ── Vocabularies (keys match the API, labels match the website) ──────────────

/** The 14 allergens in Schedule 1 of the Food Information Regulations 2014. */
export const ALLERGENS = [
  { key: 'celery', label: 'Celery', short: 'Celery' },
  { key: 'gluten', label: 'Cereals containing gluten', short: 'Gluten' },
  { key: 'crustaceans', label: 'Crustaceans', short: 'Crustaceans' },
  { key: 'eggs', label: 'Eggs', short: 'Eggs' },
  { key: 'fish', label: 'Fish', short: 'Fish' },
  { key: 'lupin', label: 'Lupin', short: 'Lupin' },
  { key: 'milk', label: 'Milk', short: 'Milk' },
  { key: 'molluscs', label: 'Molluscs', short: 'Molluscs' },
  { key: 'mustard', label: 'Mustard', short: 'Mustard' },
  { key: 'tree_nuts', label: 'Tree nuts', short: 'Tree nuts' },
  { key: 'peanuts', label: 'Peanuts', short: 'Peanuts' },
  { key: 'sesame', label: 'Sesame', short: 'Sesame' },
  { key: 'soya', label: 'Soya', short: 'Soya' },
  { key: 'sulphites', label: 'Sulphur dioxide / sulphites (over 10 mg/kg or litre)', short: 'Sulphites' },
] as const;

/** GHS hazard pictograms (GB CLP). */
export const PICTOGRAMS = [
  { key: 'ghs01', label: 'Explosive', code: 'GHS01' },
  { key: 'ghs02', label: 'Flammable', code: 'GHS02' },
  { key: 'ghs03', label: 'Oxidising', code: 'GHS03' },
  { key: 'ghs04', label: 'Gas under pressure', code: 'GHS04' },
  { key: 'ghs05', label: 'Corrosive', code: 'GHS05' },
  { key: 'ghs06', label: 'Acute toxicity (toxic)', code: 'GHS06' },
  { key: 'ghs07', label: 'Harmful / irritant', code: 'GHS07' },
  { key: 'ghs08', label: 'Serious health hazard', code: 'GHS08' },
  { key: 'ghs09', label: 'Hazardous to the environment', code: 'GHS09' },
] as const;

export const BUILT_LABELS: Record<string, string> = { yes: 'Yes', no: 'No (built in or after 2000)', unknown: 'Not known' };
export const SURVEY_LABELS: Record<string, string> = { management: 'Management survey', refurbishment_demolition: 'Refurbishment and demolition survey' };
export const CONDITION_LABELS: Record<string, string> = { good: 'Good', low_damage: 'Low damage', medium_damage: 'Medium damage', high_damage: 'High damage' };
export const PRIORITY_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
export const ACTION_LABELS: Record<string, string> = { manage: 'Manage in place', encapsulate: 'Encapsulate / repair', remove: 'Remove' };

// ── Wording (from the website pages) ─────────────────────────────────────────

export const ALLERGEN_INFO = 'These records support your allergen controls under the Food Information Regulations 2014. Food that is prepacked for direct sale (PPDS) also needs a label with the name and full ingredients list, with the 14 allergens emphasised (Natasha\'s Law). Review the records whenever a recipe or supplier changes.';
export const PPDS_BADGE = 'PPDS: full label needed';
export const PPDS_NOTE = 'Prepacked for direct sale: see full ingredients label';

export const COSHH_INFO = 'The Control of Substances Hazardous to Health Regulations 2002 expect you to assess the risks from hazardous substances, put controls in place and review the assessment regularly and whenever something changes.';
export const COSHH_SDS_NOTE = 'First aid, storage, spill and fire-fighting advice are in the supplier\'s safety data sheet. Read it before using the substance.';

export const ASBESTOS_WARNING = 'Do not drill, cut, sand, fix to or otherwise disturb any material listed here. Show contractors the asbestos register before they start any work that could disturb the building fabric (drilling, cutting, fixing, lifting floors or ceilings). Work on refurbishment or demolition needs a refurbishment and demolition survey of the area first.';
export const ASBESTOS_SUSPECT = 'If you find damaged material or something you think may contain asbestos, stop work, keep people away and tell the person in charge.';
export const ASBESTOS_INFO = 'Under regulation 4 of the Control of Asbestos Regulations 2012, whoever is responsible for maintaining non-domestic premises must find out whether asbestos is present, record where it is and its condition, and manage the risk. Buildings built before 2000 may contain asbestos.';

export const READ_ONLY_NOTE = 'Read only on the phone. Add, edit or remove records on the website.';

// ── Record shapes (GET /api/registers/*) ─────────────────────────────────────

export interface Site { id: number; name: string }

export interface AllergenItem {
  id: number;
  siteId: number | null;
  name: string;
  description: string | null;
  allergens: string[];
  ppds: boolean;
  lastReviewedAt: string | null;
  reviewedBy: string | null;
}

export interface CoshhSubstance {
  id: number;
  siteId: number | null;
  productName: string;
  supplier: string | null;
  hazardPictograms: string[];
  whereUsed: string | null;
  sdsObjectPath: string | null;
  sdsFileName: string | null;
  assessmentDate: string | null;
  reviewDue: string | null;
  controls: string | null;
  status: 'in_use' | 'withdrawn' | string;
  reviewOverdue: boolean;
}

export interface AsbestosEntry {
  id: number;
  location: string;
  material: string;
  condition: string;
  riskScore: number | null;
  priority: string;
  action: string;
  lastInspected: string | null;
  notes: string | null;
}

export interface PastSurvey {
  id: number;
  surveyType: string | null;
  surveyDate: string | null;
  surveyor: string | null;
  reportFileName: string | null;
  replacedAt: string;
}

export interface AsbestosRecord {
  id: number;
  siteId: number | null;
  builtBefore2000: string;
  noAsbestosExpected: boolean;
  surveyType: string | null;
  surveyDate: string | null;
  surveyor: string | null;
  reportObjectPath: string | null;
  reportFileName: string | null;
  planReviewDue: string | null;
  planReviewOverdue: boolean;
  notes: string | null;
  entries: AsbestosEntry[];
  surveyHistory?: PastSurvey[];
}

// ── Display helpers ──────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UK display date (d MMM yyyy) for a YYYY-MM-DD value or ISO timestamp. */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : value;
}

/** "15 Oct 2026, 09:05" in the phone's local time. */
export function fmtDateTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The website's site label: removed sites and sites the list doesn't know. */
export function siteName(sites: readonly Site[], id: number | null | undefined): string {
  if (id == null) return 'Site removed';
  return sites.find((site) => site.id === id)?.name ?? 'Unknown site';
}

function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((field) => !!field && field.toLowerCase().includes(q));
}

function inSite(siteFilter: number | null, siteId: number | null): boolean {
  return siteFilter === null || siteId === siteFilter;
}

// ── Allergens ────────────────────────────────────────────────────────────────

const ALLERGEN_SHORT: Record<string, string> = Object.fromEntries(ALLERGENS.map((a) => [a.key, a.short]));

/** The website's search: dish name and description. */
export function filterAllergens(items: readonly AllergenItem[], siteFilter: number | null, query: string): AllergenItem[] {
  return items.filter((item) => inSite(siteFilter, item.siteId) && matches(query, item.name, item.description));
}

/** All 14 allergens in regulation order, each marked contains / doesn't. */
export function allergenMatrix(item: Pick<AllergenItem, 'allergens'>): { key: string; label: string; contains: boolean }[] {
  const ticked = new Set(item.allergens ?? []);
  return ALLERGENS.map((a) => ({ key: a.key, label: a.label, contains: ticked.has(a.key) }));
}

/** Short names of the allergens a dish contains, in regulation order. */
export function allergenShortNames(item: Pick<AllergenItem, 'allergens'>): string[] {
  return allergenMatrix(item).filter((row) => row.contains).map((row) => ALLERGEN_SHORT[row.key]);
}

export function allergenReviewedText(item: Pick<AllergenItem, 'lastReviewedAt' | 'reviewedBy'>): string {
  return `Reviewed: ${item.lastReviewedAt ? fmtDate(item.lastReviewedAt) : 'not recorded'}${item.reviewedBy ? ` by ${item.reviewedBy}` : ''}`;
}

// ── COSHH ────────────────────────────────────────────────────────────────────

const PICTOGRAM_BY_KEY: Record<string, { label: string; code: string }> = Object.fromEntries(PICTOGRAMS.map((p) => [p.key, p]));

/** The website's search (product, supplier, where used); withdrawn hidden unless asked. */
export function filterCoshh(items: readonly CoshhSubstance[], siteFilter: number | null, query: string, showWithdrawn: boolean): CoshhSubstance[] {
  return items.filter((item) => inSite(siteFilter, item.siteId)
    && (showWithdrawn || item.status === 'in_use')
    && matches(query, item.productName, item.supplier, item.whereUsed));
}

export function pictogramLabels(keys: readonly string[]): { key: string; label: string; code: string }[] {
  return (keys ?? []).map((key) => ({ key, ...(PICTOGRAM_BY_KEY[key] ?? { label: key, code: key.toUpperCase() }) }));
}

export type ReviewState = 'overdue' | 'soon' | 'ok' | 'none' | 'withdrawn';

/** Whole days from today to a YYYY-MM-DD date (negative when past). */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** The website's review badge: overdue, due within 30 days, later, none, withdrawn. */
export function coshhReview(item: Pick<CoshhSubstance, 'status' | 'reviewDue' | 'reviewOverdue'>, today: string): { state: ReviewState; text: string } {
  if (item.status === 'withdrawn') return { state: 'withdrawn', text: 'Withdrawn' };
  if (!item.reviewDue) return { state: 'none', text: 'No review date' };
  if (item.reviewOverdue) return { state: 'overdue', text: `Review overdue (${fmtDate(item.reviewDue)})` };
  return daysUntil(item.reviewDue, today) <= 30
    ? { state: 'soon', text: `Review due ${fmtDate(item.reviewDue)}` }
    : { state: 'ok', text: `Review ${fmtDate(item.reviewDue)}` };
}

// ── Asbestos ─────────────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

/** Search by site name, location, material or notes; matching sites keep all their materials. */
export function filterAsbestos(records: readonly AsbestosRecord[], sites: readonly Site[], siteFilter: number | null, query: string): AsbestosRecord[] {
  return records.filter((record) => inSite(siteFilter, record.siteId)
    && (matches(query, siteName(sites, record.siteId), record.notes)
      || record.entries.some((entry) => matches(query, entry.location, entry.material, entry.notes))));
}

/** Highest priority among a record's materials, or null with none. */
export function highestPriority(record: Pick<AsbestosRecord, 'entries'>): string | null {
  let best: string | null = null;
  for (const entry of record.entries) {
    if ((PRIORITY_RANK[entry.priority] ?? 0) > (best ? PRIORITY_RANK[best] ?? 0 : 0)) best = entry.priority;
  }
  return best;
}

/** Materials sorted for someone on site: high priority and worst condition first. */
export function sortEntriesForSite(entries: readonly AsbestosEntry[]): AsbestosEntry[] {
  const condition: Record<string, number> = { high_damage: 4, medium_damage: 3, low_damage: 2, good: 1 };
  return [...entries].sort((a, b) => (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0)
    || (condition[b.condition] ?? 0) - (condition[a.condition] ?? 0)
    || a.location.localeCompare(b.location));
}

/** The website's survey line for a record or a past survey. */
export function surveyText(survey: Pick<AsbestosRecord, 'surveyType' | 'surveyDate' | 'surveyor'>, noAsbestosExpected = false): string {
  if (!survey.surveyType) return noAsbestosExpected ? 'No survey recorded' : 'No survey recorded yet';
  return `${SURVEY_LABELS[survey.surveyType] ?? survey.surveyType}${survey.surveyDate ? ` on ${fmtDate(survey.surveyDate)}` : ''}${survey.surveyor ? ` by ${survey.surveyor}` : ''}`;
}

export function planReviewText(record: Pick<AsbestosRecord, 'noAsbestosExpected' | 'planReviewDue' | 'planReviewOverdue'>): string | null {
  if (record.noAsbestosExpected || !record.planReviewDue) return null;
  return `${record.planReviewOverdue ? 'Plan review overdue' : 'Plan review due'} ${fmtDate(record.planReviewDue)}`;
}

export function priorityText(entry: Pick<AsbestosEntry, 'priority' | 'riskScore'>): string {
  return `${PRIORITY_LABELS[entry.priority] ?? entry.priority} priority${entry.riskScore != null ? ` (score ${entry.riskScore})` : ''}`;
}

// ── Offline copy of the last loaded list ─────────────────────────────────────

export const REGISTER_CACHE_PREFIX = 'complytrack-register-cache:';
export type RegisterName = 'allergens' | 'coshh' | 'asbestos' | 'sites';

export interface RegisterIdentity { clientId: number; userId: number }

export interface CachedRegister<T> { version: 1; savedAt: string; data: T[] }

/** Partitioned by client and user, like the other on-device records. */
export function registerCacheKey(identity: RegisterIdentity, name: RegisterName): string {
  return `${REGISTER_CACHE_PREFIX}${identity.clientId}:${identity.userId}:${name}`;
}

export function serializeRegisterCache<T>(data: T[], savedAt: Date): string {
  return JSON.stringify({ version: 1, savedAt: savedAt.toISOString(), data } satisfies CachedRegister<T>);
}

/** A stored copy, or null when missing, corrupt or from another format. */
export function parseRegisterCache<T>(raw: string | null | undefined): CachedRegister<T> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedRegister<T>>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.data) || typeof parsed.savedAt !== 'string'
      || Number.isNaN(Date.parse(parsed.savedAt))) return null;
    return parsed as CachedRegister<T>;
  } catch {
    return null;
  }
}

/**
 * What the screen shows: the live list once loaded; while loading or after a
 * failed connection, the copy saved on the phone (flagged so the screen says
 * when it was last updated). An answer from the server (no access, service
 * switched off) is shown as an error, never hidden behind the saved copy.
 */
export function chooseRegisterData<T>(input: {
  live: T[] | undefined;
  cached: CachedRegister<T> | null;
  errored: boolean;
  connectionError: boolean;
}): { data: T[] | null; fromCache: boolean; savedAt: string | null } {
  if (input.live) return { data: input.live, fromCache: false, savedAt: null };
  if (input.cached && (!input.errored || input.connectionError)) {
    return { data: input.cached.data, fromCache: true, savedAt: input.cached.savedAt };
  }
  return { data: null, fromCache: false, savedAt: null };
}

export function lastUpdatedText(savedAt: string): string {
  return `Saved on this phone. Last updated ${fmtDateTime(new Date(savedAt))}.`;
}
