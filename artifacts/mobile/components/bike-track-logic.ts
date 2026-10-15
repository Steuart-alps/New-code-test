/**
 * BikeTrack on the phone: the website's hire, return and service forms
 * (compliance-tracker pages/bike-track.tsx), same fields and the same payload
 * shape for POST /api/bike-track/hires, /hires/:id/return and /services.
 * Adding, editing and deleting bikes, settings and the hire register stay on
 * the website.
 *
 * A hire (with its pre-ride safety check) and a service log are new records,
 * so they go through the device outbox. A return updates an existing hire on
 * the server, so it is online-only: it is never saved on the device.
 *
 * Import-free so tests can load it directly with Node.
 */

export interface BikeSite { id: number; name: string }

/** GET /bike-track/bikes (Drizzle rows, camelCase). */
export interface Bike {
  id: number;
  siteId: number | null;
  ref: string;
  name: string | null;
  type: string;
  status: string;
  active: boolean;
}

/** GET /bike-track/hires (raw SQL rows, snake_case; dates may carry a time). */
export interface BikeHire {
  id: number;
  bike_id: number;
  site_id: number | null;
  guest_name: string;
  guest_contact: string | null;
  hire_date: string;
  return_date_expected: string | null;
  deposit_pence: number | null;
  status: string;
  bike_ref: string;
  bike_name: string | null;
  pre_result: string | null;
}

/** GET /bike-track/services (raw SQL rows, snake_case). */
export interface BikeService {
  id: number;
  bike_id: number;
  service_date: string;
  service_type: string;
  serviced_by: string | null;
  next_service_date: string | null;
  cost_pence: number | null;
  notes: string | null;
  bike_ref: string;
  bike_name: string | null;
}

/** GET /bike-track/services/latest (one row per bike). */
export interface BikeLatestService {
  bike_id: number;
  service_date: string;
  next_service_date: string | null;
}

export const CHECK_ITEMS: readonly { key: string; label: string }[] = [
  { key: 'brakesFront', label: 'Front brakes' },
  { key: 'brakesRear', label: 'Rear brakes' },
  { key: 'tyreFront', label: 'Front tyre (pressure & condition)' },
  { key: 'tyreRear', label: 'Rear tyre (pressure & condition)' },
  { key: 'chainGears', label: 'Chain & gears' },
  { key: 'lightsFront', label: 'Front light' },
  { key: 'lightsRear', label: 'Rear light / reflector' },
  { key: 'frame', label: 'Frame (no cracks or damage)' },
  { key: 'saddleSeatpost', label: 'Saddle & seatpost (secure)' },
  { key: 'handlebars', label: 'Handlebars & grips (secure)' },
  { key: 'pedals', label: 'Pedals' },
  { key: 'helmetProvided', label: 'Helmet provided to guest' },
];
export type CheckValue = 'pass' | 'fail' | 'na';
export type CheckItems = Record<string, CheckValue>;

export const SERVICE_TYPES = [
  { value: 'annual', label: 'Annual' },
  { value: 'interim', label: 'Interim (6-month)' },
  { value: 'adhoc', label: 'Ad-hoc / Repair' },
] as const;

const BIKE_TYPE_LABELS: Record<string, string> = {
  hybrid: 'Hybrid', road: 'Road', mountain: 'Mountain', ebike: 'E-Bike', kids: 'Kids', cargo: 'Cargo', other: 'Other',
};
const STATUS_LABELS: Record<string, string> = {
  available: 'Available', hired: 'On hire', maintenance: 'Maintenance', retired: 'Retired',
};
export const bikeTypeLabel = (value: string) => BIKE_TYPE_LABELS[value] ?? value;
export const bikeStatusLabel = (value: string) => STATUS_LABELS[value] ?? value;
export const serviceTypeLabel = (value: string) => SERVICE_TYPES.find((type) => type.value === value)?.label ?? value;
export const bikeTitle = (bike: { ref: string; name: string | null }) => (bike.name ? `${bike.ref} — ${bike.name}` : bike.ref);

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

/** First ten characters of an API date (raw rows can carry a time). */
export const dayOf = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

/**
 * Site the records belong to. With sites on the account one must be chosen;
 * an account without sites works across all bikes (null).
 */
export function bikeSiteChoice(siteId: number | null, sites: BikeSite[] | undefined):
  { ready: true; siteId: number | null } | { ready: false } {
  if (!sites) return { ready: false };
  if (sites.length === 0) return { ready: true, siteId: null };
  return siteId !== null && sites.some((site) => site.id === siteId) ? { ready: true, siteId } : { ready: false };
}

/** Active bikes registered at the site, plus bikes without a site. */
export function bikesForSite(bikes: Bike[], siteId: number | null): Bike[] {
  return bikes.filter((bike) => bike.active && (siteId === null || bike.siteId === siteId || bike.siteId === null));
}

/** Active hires at the site: the hire's own site, else its bike's site. */
export function activeHiresForSite(hires: BikeHire[], bikes: Bike[], siteId: number | null): BikeHire[] {
  const bikeSite = new Map(bikes.map((bike) => [bike.id, bike.siteId]));
  return hires.filter((hire) => {
    if (hire.status !== 'active') return false;
    if (siteId === null) return true;
    const site = hire.site_id ?? bikeSite.get(hire.bike_id) ?? null;
    return site === siteId || site === null;
  });
}

/** Bikes with a hire saved on this device that the server has not confirmed. */
export function pendingHireBikeIds(entries: { kind: string; state: string; body: Record<string, unknown> }[]): Set<number> {
  return new Set(entries
    .filter((entry) => entry.kind === 'bike-hire' && entry.state !== 'sent' && typeof entry.body.bikeId === 'number')
    .map((entry) => entry.body.bikeId as number));
}

/** Next service due, from the bike's latest service (as the website's fleet list). */
export function serviceDue(latest: BikeLatestService | undefined, today: string): { date: string; overdue: boolean } | null {
  const date = dayOf(latest?.next_service_date);
  return date ? { date, overdue: date < today } : null;
}

export function isOverdueReturn(hire: BikeHire, today: string): boolean {
  const expected = dayOf(hire.return_date_expected);
  return hire.status === 'active' && !!expected && expected < today;
}

export function emptyCheckItems(): CheckItems {
  return Object.fromEntries(CHECK_ITEMS.map((item) => [item.key, 'pass'])) as CheckItems;
}

/** Fail when any item fails, as the website works it out. */
export function overallResult(items: CheckItems): 'pass' | 'fail' {
  return Object.values(items).some((value) => value === 'fail') ? 'fail' : 'pass';
}

/** Pounds as typed (e.g. "20" or "20.00") to pence; null when blank. */
export function poundsToPence(value: string): number | null | 'invalid' {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return 'invalid';
  return Math.round(parseFloat(text) * 100);
}

/** The account's default deposit (pence setting) as pounds text, or blank. */
export function defaultDepositText(config: Record<string, string> | undefined): string {
  const pence = parseInt(config?.bike_default_deposit_pence ?? '', 10);
  return !isNaN(pence) && pence > 0 ? (pence / 100).toFixed(2) : '';
}

/** Expected return from the account's default hire length, or blank. */
export function defaultExpectedReturn(config: Record<string, string> | undefined, now: Date = new Date()): string {
  const hours = parseFloat(config?.bike_hire_duration_hours ?? '');
  if (isNaN(hours) || hours <= 0) return '';
  const date = new Date(now.getTime());
  date.setHours(date.getHours() + hours);
  return localDate(date);
}

/** Annual: a year on; interim: six months on; ad-hoc: none (as the website). */
export function autoNextService(serviceDate: string, serviceType: string): string {
  if (!isCalendarDate(serviceDate)) return '';
  const [year, month, day] = serviceDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (serviceType === 'annual') date.setFullYear(date.getFullYear() + 1);
  else if (serviceType === 'interim') date.setMonth(date.getMonth() + 6);
  else return '';
  return localDate(date);
}

const text = (value: string) => value.trim() || null;
export type BikePayloadResult = { ok: true; payload: Record<string, unknown> } | { ok: false; title: string; message: string };

export interface BikeCheckDraft {
  skip: boolean;
  items: CheckItems;
  performedBy: string;
  checkNotes: string;
}

function checkPayload(check: BikeCheckDraft, checkDate: string) {
  return {
    ...check.items,
    performedBy: text(check.performedBy),
    staffRosterId: null,
    checkDate,
    overallResult: overallResult(check.items),
    checkNotes: text(check.checkNotes),
  };
}

export interface BikeHireDraft {
  guestName: string;
  guestContact: string;
  hireDate: string;
  returnExpected: string;
  deposit: string;
  check: BikeCheckDraft;
}

export function buildHirePayload(draft: BikeHireDraft, bike: Bike | undefined, siteId: number | null): BikePayloadResult {
  if (!bike || !bike.active || bike.status !== 'available') {
    return { ok: false, title: 'Bike not available', message: 'Only an available bike can be hired out.' };
  }
  if (!draft.guestName.trim()) return { ok: false, title: 'Guest name needed', message: "Enter the guest's name." };
  if (draft.guestName.trim().length > 200 || draft.guestContact.trim().length > 200) {
    return { ok: false, title: 'Too long', message: 'Keep the guest name and contact under 200 characters.' };
  }
  if (!isCalendarDate(draft.hireDate)) return { ok: false, title: 'Check the date', message: 'Enter the hire date as YYYY-MM-DD.' };
  const expected = draft.returnExpected.trim();
  if (expected && !isCalendarDate(expected)) {
    return { ok: false, title: 'Check the return date', message: 'Enter the expected return as YYYY-MM-DD, or leave it blank.' };
  }
  const depositPence = poundsToPence(draft.deposit);
  if (depositPence === 'invalid') return { ok: false, title: 'Check the deposit', message: 'Enter the deposit in pounds, e.g. 20.00.' };
  const payload: Record<string, unknown> = {
    bikeId: bike.id,
    guestName: draft.guestName.trim(),
    guestContact: text(draft.guestContact),
    hireDate: draft.hireDate,
    returnDateExpected: expected || null,
    depositPence,
    siteId,
  };
  if (!draft.check.skip) payload.preHireCheck = checkPayload(draft.check, draft.hireDate);
  return { ok: true, payload };
}

export interface BikeReturnDraft {
  returnDate: string;
  depositReturned: boolean;
  notes: string;
  check: BikeCheckDraft;
}

export function buildReturnPayload(draft: BikeReturnDraft): BikePayloadResult {
  if (!isCalendarDate(draft.returnDate)) return { ok: false, title: 'Check the date', message: 'Enter the return date as YYYY-MM-DD.' };
  const payload: Record<string, unknown> = {
    returnDateActual: draft.returnDate,
    depositReturned: draft.depositReturned,
    notes: text(draft.notes),
  };
  if (!draft.check.skip) payload.postReturnCheck = checkPayload(draft.check, draft.returnDate);
  return { ok: true, payload };
}

export interface BikeServiceDraft {
  bikeId: number | null;
  serviceDate: string;
  serviceType: string;
  nextServiceDate: string;
  cost: string;
  servicedBy: string;
  notes: string;
}

export function buildServicePayload(draft: BikeServiceDraft): BikePayloadResult {
  if (draft.bikeId === null) return { ok: false, title: 'Choose a bike', message: 'Choose the bike that was serviced.' };
  if (!isCalendarDate(draft.serviceDate)) return { ok: false, title: 'Check the date', message: 'Enter the service date as YYYY-MM-DD.' };
  if (!SERVICE_TYPES.some((type) => type.value === draft.serviceType)) {
    return { ok: false, title: 'Choose the type', message: 'Choose annual, interim or ad-hoc.' };
  }
  const next = draft.nextServiceDate.trim();
  if (next && !isCalendarDate(next)) {
    return { ok: false, title: 'Check the next service', message: 'Enter the next service due as YYYY-MM-DD, or leave it blank.' };
  }
  const costPence = poundsToPence(draft.cost);
  if (costPence === 'invalid') return { ok: false, title: 'Check the cost', message: 'Enter the cost in pounds, e.g. 45.00.' };
  return {
    ok: true,
    payload: {
      serviceDate: draft.serviceDate,
      serviceType: draft.serviceType,
      servicedBy: text(draft.servicedBy),
      nextServiceDate: next || null,
      costPence,
      notes: text(draft.notes),
      bikeId: draft.bikeId,
    },
  };
}

/** A request that never reached the server (no signal), as opposed to a refusal. */
export function isConnectionFailure(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : 0;
  return !(status > 0);
}

export const RETURN_NEEDS_SIGNAL = 'A return updates the hire on the server, so it cannot be saved on this device. '
  + 'Nothing was recorded. Keep the details and try again when you have signal.';
