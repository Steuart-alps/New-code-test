/**
 * GreenTrack machine records on the phone: defect reports, fuel / oil logs,
 * service records and PUWER inspections. Same fields, choices and payload
 * shape as the website's dialogs (compliance-tracker pages/green-track.tsx)
 * for POST /api/green-track/defects, /fuel-logs, /service-records and
 * /puwer-inspections. Machines, edits, defect status changes and deletes stay
 * on the website.
 *
 * Import-free so tests can load it directly with Node.
 */

export type GreenRecordTab = 'defect' | 'fuel' | 'service' | 'puwer';

export interface GreenMachineOption { id: number; name: string; type: string | null; siteName: string | null }

export const DEFECT_SEVERITY_LABELS: Record<string, string> = { minor: 'Minor', major: 'Major', critical: 'Critical' };
export const DEFECT_STATUS_LABELS: Record<string, string> = { open: 'Open', under_repair: 'Under repair', resolved: 'Resolved' };
export const FUEL_TYPE_LABELS: Record<string, string> = {
  diesel: 'Diesel', petrol: 'Petrol', oil: 'Engine oil', hyd_oil: 'Hydraulic oil', other: 'Other fluid',
};
export const SERVICE_TYPE_LABELS: Record<string, string> = {
  scheduled: 'Scheduled service', annual: 'Annual service', unscheduled: 'Unscheduled / repair',
};
export const PUWER_TYPE_LABELS: Record<string, string> = {
  thorough_examination: 'Thorough examination (PUWER)',
  loler_examination: 'Thorough examination (LOLER)',
  annual_inspection: 'Annual inspection',
  periodic_inspection: 'Periodic inspection',
  other: 'Other',
};

export const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));
export const labelFor = (labels: Record<string, string>, value: string | null | undefined) =>
  (value ? labels[value] ?? value.replace(/_/g, ' ') : '');

/**
 * Service records and PUWER inspections are manager records: the API only
 * accepts them from client admins and consultants (as on the website).
 * Defect reports and fuel logs are open to every non-viewer.
 */
export function canRecordGreenTab(role: string | null | undefined, tab: GreenRecordTab): boolean {
  if (!role || role === 'client_viewer') return false;
  return tab === 'defect' || tab === 'fuel' || role === 'client_admin' || role === 'consultant';
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

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};
const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Active machines from GET /api/green-track/machines (snake or camel case). */
export function normalizeGreenMachines(response: unknown): GreenMachineOption[] {
  const list = Array.isArray(response) ? response : [];
  return list.map(asRecord)
    .filter((item) => item.active !== false && Number.isInteger(Number(item.id)))
    .map((item) => ({
      id: Number(item.id),
      name: String(item.name ?? `Machine ${item.id}`),
      type: optionalText(item.type ?? item.machine_type ?? item.machineType),
      siteName: optionalText(item.site_name ?? item.siteName),
    }));
}

/** One recent record, flattened for the list under each form. */
export interface GreenRecordRow {
  id: number;
  machineId: number | null;
  machineName: string;
  date: string;
  title: string;
  detail: string | null;
  flag: { label: string; tone: 'danger' | 'warning' | 'ok' | 'muted' } | null;
}

/** Recent records of one tab from its GET list (snake or camel case). */
export function normalizeGreenRecords(tab: GreenRecordTab, response: unknown): GreenRecordRow[] {
  const list = Array.isArray(response) ? response : [];
  return list.map(asRecord).filter((item) => Number.isInteger(Number(item.id))).map((item) => {
    const pick = (snake: string, camel: string) => item[snake] ?? item[camel];
    const machineId = Number(pick('machine_id', 'machineId'));
    const base = {
      id: Number(item.id),
      machineId: Number.isInteger(machineId) ? machineId : null,
      machineName: String(pick('machine_name', 'machineName') ?? 'Machine'),
    };
    const day = (value: unknown) => (typeof value === 'string' ? value.slice(0, 10) : '');
    switch (tab) {
      case 'defect': {
        const status = String(item.status ?? 'open');
        const severity = String(item.severity ?? 'minor');
        return {
          ...base,
          date: day(pick('report_date', 'reportDate')),
          title: optionalText(item.description) ?? 'Defect',
          detail: [labelFor(DEFECT_SEVERITY_LABELS, severity), pick('out_of_service', 'outOfService') ? 'Out of service' : null,
            optionalText(pick('reported_by', 'reportedBy'))].filter(Boolean).join(' · ') || null,
          flag: { label: labelFor(DEFECT_STATUS_LABELS, status), tone: status === 'resolved' ? 'ok' : severity === 'critical' ? 'danger' : 'warning' },
        };
      }
      case 'fuel': {
        const litres = pick('quantity_litres', 'quantityLitres');
        const hours = pick('engine_hours', 'engineHours');
        return {
          ...base,
          date: day(pick('log_date', 'logDate')),
          title: labelFor(FUEL_TYPE_LABELS, String(pick('fuel_type', 'fuelType') ?? 'diesel')),
          detail: [litres != null && litres !== '' ? `${Number(litres)} L` : null, hours != null && hours !== '' ? `${hours} h` : null,
            optionalText(pick('filled_by', 'filledBy'))].filter(Boolean).join(' · ') || null,
          flag: null,
        };
      }
      case 'service': {
        const next = day(pick('next_service_date', 'nextServiceDate'));
        return {
          ...base,
          date: day(pick('service_date', 'serviceDate')),
          title: labelFor(SERVICE_TYPE_LABELS, String(pick('service_type', 'serviceType') ?? 'scheduled')),
          detail: [optionalText(pick('work_performed', 'workPerformed')), optionalText(pick('serviced_by', 'servicedBy'))]
            .filter(Boolean).join(' · ') || null,
          flag: next ? { label: `Next ${next}`, tone: 'muted' } : null,
        };
      }
      case 'puwer': {
        const safe = pick('safe_to_operate', 'safeToOperate') !== false;
        return {
          ...base,
          date: day(pick('inspection_date', 'inspectionDate')),
          title: labelFor(PUWER_TYPE_LABELS, String(pick('inspection_type', 'inspectionType') ?? 'thorough_examination')),
          detail: [optionalText(pick('inspector_name', 'inspectorName')), optionalText(pick('inspector_company', 'inspectorCompany')),
            optionalText(pick('defects_found', 'defectsFound'))].filter(Boolean).join(' · ') || null,
          flag: safe ? { label: 'Safe to operate', tone: 'ok' } : { label: 'Not safe', tone: 'danger' },
        };
      }
    }
  });
}

export type GreenPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; title: string; message: string };

const text = (value: string) => value.trim() || null;
const fail = (title: string, message: string): GreenPayloadResult => ({ ok: false, title, message });

function wholeNumber(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : undefined;
}

function decimal(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d{1,7}(\.\d+)?$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** Pounds as typed (e.g. "12.50") to whole pence, as the website does. */
function pence(value: string): number | null | undefined {
  const pounds = decimal(value);
  return pounds == null ? pounds : Math.round(pounds * 100);
}

function machineAndDate(machineId: number | null, date: string, label: string): GreenPayloadResult | null {
  if (machineId === null) return fail('Choose a machine', 'Select the machine this record is for.');
  if (!isCalendarDate(date)) return fail('Check the date', `Enter the ${label} as YYYY-MM-DD.`);
  return null;
}

export interface DefectDraft {
  reportDate: string;
  reportedBy: string;
  severity: string;
  outOfService: boolean;
  description: string;
  notes: string;
}

/**
 * New defects are always reported open: the API ignores status, resolution
 * and resolved date on create, so the phone does not offer them.
 */
export function buildDefectPayload(draft: DefectDraft, machineId: number | null): GreenPayloadResult {
  const invalid = machineAndDate(machineId, draft.reportDate, 'report date');
  if (invalid) return invalid;
  if (!draft.description.trim()) return fail('Describe the defect', 'Describe the fault, damage or safety concern.');
  if (!(draft.severity in DEFECT_SEVERITY_LABELS)) return fail('Choose a severity', 'Choose minor, major or critical.');
  return {
    ok: true,
    payload: {
      machineId, reportDate: draft.reportDate, reportedBy: text(draft.reportedBy), description: draft.description.trim(),
      severity: draft.severity, outOfService: draft.outOfService, notes: text(draft.notes),
    },
  };
}

export interface FuelDraft {
  logDate: string;
  fuelType: string;
  quantityLitres: string;
  engineHours: string;
  costPounds: string;
  filledBy: string;
  notes: string;
}

export function buildFuelPayload(draft: FuelDraft, machineId: number | null): GreenPayloadResult {
  const invalid = machineAndDate(machineId, draft.logDate, 'date');
  if (invalid) return invalid;
  if (!(draft.fuelType in FUEL_TYPE_LABELS)) return fail('Choose a type', 'Choose what was added.');
  const quantityLitres = decimal(draft.quantityLitres);
  // The column holds up to 9999.99 litres; a larger value would fail on the
  // server after being saved on the device.
  if (quantityLitres === undefined || (quantityLitres !== null && quantityLitres >= 10000)) {
    return fail('Check the quantity', 'Enter the litres as a number (e.g. 25.5), or leave it blank.');
  }
  const engineHours = wholeNumber(draft.engineHours);
  if (engineHours === undefined) return fail('Check the engine hours', 'Enter whole engine hours (e.g. 512), or leave it blank.');
  const costPence = pence(draft.costPounds);
  if (costPence === undefined) return fail('Check the cost', 'Enter the cost in pounds (e.g. 31.50), or leave it blank.');
  return {
    ok: true,
    payload: {
      machineId, logDate: draft.logDate, fuelType: draft.fuelType, quantityLitres, engineHours, costPence,
      filledBy: text(draft.filledBy), notes: text(draft.notes),
    },
  };
}

export interface ServiceDraft {
  serviceDate: string;
  serviceType: string;
  hoursAtService: string;
  nextServiceHours: string;
  nextServiceDate: string;
  workPerformed: string;
  servicedBy: string;
  costPounds: string;
  notes: string;
}

export function buildServicePayload(draft: ServiceDraft, machineId: number | null): GreenPayloadResult {
  const invalid = machineAndDate(machineId, draft.serviceDate, 'service date');
  if (invalid) return invalid;
  if (!(draft.serviceType in SERVICE_TYPE_LABELS)) return fail('Choose a service type', 'Choose the type of service.');
  const hoursAtService = wholeNumber(draft.hoursAtService);
  const nextServiceHours = wholeNumber(draft.nextServiceHours);
  if (hoursAtService === undefined || nextServiceHours === undefined) {
    return fail('Check the hours', 'Enter engine hours as whole numbers (e.g. 450), or leave them blank.');
  }
  const next = draft.nextServiceDate.trim();
  if (next && !isCalendarDate(next)) return fail('Check the next service date', 'Enter it as YYYY-MM-DD, or leave it blank.');
  const costPence = pence(draft.costPounds);
  if (costPence === undefined) return fail('Check the cost', 'Enter the cost in pounds (e.g. 120.00), or leave it blank.');
  return {
    ok: true,
    payload: {
      machineId, serviceDate: draft.serviceDate, serviceType: draft.serviceType, hoursAtService, nextServiceHours,
      nextServiceDate: next || null, workPerformed: text(draft.workPerformed), servicedBy: text(draft.servicedBy),
      costPence, notes: text(draft.notes),
    },
  };
}

export interface PuwerDraft {
  inspectionDate: string;
  nextInspectionDate: string;
  inspectionType: string;
  inspectorName: string;
  inspectorCompany: string;
  certRef: string;
  safeToOperate: boolean;
  defectsFound: string;
  notes: string;
}

/** The result the website sends; the API stores fail when not safe, else pass. */
export function puwerResult(safeToOperate: boolean, defectsFound: string): 'pass' | 'advisory' | 'fail' {
  if (!safeToOperate) return 'fail';
  return defectsFound.trim() ? 'advisory' : 'pass';
}

export function buildPuwerPayload(draft: PuwerDraft, machineId: number | null): GreenPayloadResult {
  const invalid = machineAndDate(machineId, draft.inspectionDate, 'inspection date');
  if (invalid) return invalid;
  if (!(draft.inspectionType in PUWER_TYPE_LABELS)) return fail('Choose an inspection type', 'Choose the type of inspection.');
  const next = draft.nextInspectionDate.trim();
  if (next && !isCalendarDate(next)) return fail('Check the next inspection date', 'Enter it as YYYY-MM-DD, or leave it blank.');
  return {
    ok: true,
    payload: {
      machineId, inspectionDate: draft.inspectionDate, nextInspectionDate: next || null, inspectionType: draft.inspectionType,
      inspectorName: text(draft.inspectorName), inspectorCompany: text(draft.inspectorCompany), certRef: text(draft.certRef),
      safeToOperate: draft.safeToOperate, defectsFound: text(draft.defectsFound),
      result: puwerResult(draft.safeToOperate, draft.defectsFound), notes: text(draft.notes),
    },
  };
}

/**
 * How a defect report or service record is sent. When the account requires
 * photos for it, the form needs signal: photos are staged first and the record
 * is sent straight away (the pre-use check approach). Otherwise it goes through
 * the device outbox and is saved without signal. While requirements are still
 * loading the form waits; if they cannot be loaded (no signal) the outbox is
 * used, and the server refuses the entry if photos turn out to be required.
 */
export function greenSendRoute(evidence: { enabled: boolean; loading: boolean; loadFailed: boolean; required: boolean }):
  'photos' | 'outbox' | 'wait' {
  if (!evidence.enabled || evidence.loadFailed) return 'outbox';
  if (evidence.loading) return 'wait';
  return evidence.required ? 'photos' : 'outbox';
}
