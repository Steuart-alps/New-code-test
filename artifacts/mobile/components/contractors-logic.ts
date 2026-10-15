/**
 * Contractors on the phone (app/manage/contractors.tsx, contractor/[id].tsx and
 * contractor-approvals.tsx): the website's compliance status, certificate
 * expiry badges and contractor email approval wording
 * (compliance-tracker lib/contractor-list-status.ts, components/badges.tsx,
 * lib/contractor-approval-actions.ts, pages/contractor-approvals.tsx).
 * Adding, editing and deleting contractors, certificates and portal invites
 * stays on the website.
 *
 * Import-free so tests can load it directly with Node.
 */

/** GET /api/contractors and /api/contractors/:id (camelCase table row). */
export interface ContractorRecord {
  id: number;
  name: string;
  company?: string | null;
  email: string;
  phone?: string | null;
  address?: string | null;
  gasSafeNumber?: string | null;
  gasSafeRegistration?: string | null;
  publicLiabilityExpiry?: string | null;
  dbsType?: string | null;
  dbsExpiryDate?: string | null;
}

/** A contractor certificate (GET /api/contractors/:id/certificates), normalised. */
export interface ContractorCertificate {
  id: number;
  name: string;
  issuer: string | null;
  completedDate: string | null;
  expiryDate: string | null;
  notes: string | null;
}

/** A queued contractor email (GET /api/fix-track/contractor-email-queue), normalised. */
export interface ContractorEmailQueueItem {
  id: number;
  emailType: string;
  createdAt: string | null;
  requestedBy: string | null;
  subject: string;
  text: string;
  siteName: string | null;
  contractorName: string | null;
  jobTitle: string | null;
}

/** A compliance check assigned to the contractor (GET /api/compliance-items?contractorId=), normalised. */
export interface ContractorCheck {
  id: number;
  title: string;
  status: string;
  dueDate: string | null;
}

type Row = Record<string, unknown>;
/** Responses are read in either field style: some routes are moving from snake_case to camelCase. */
const picker = (row: Row) => (snake: string, camel: string): unknown => row[snake] ?? row[camel];
const textOrNull = (value: unknown): string | null =>
  value === null || value === undefined || value === '' ? null : String(value);
const rowsOf = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === 'object') : [];

function normalizeContractorRow(row: Row): ContractorRecord {
  const pick = picker(row);
  return {
    id: Number(row.id),
    name: String(row.name ?? 'Contractor'),
    company: textOrNull(row.company),
    email: String(row.email ?? ''),
    phone: textOrNull(row.phone),
    address: textOrNull(row.address),
    gasSafeNumber: textOrNull(pick('gas_safe_number', 'gasSafeNumber')),
    gasSafeRegistration: textOrNull(pick('gas_safe_registration', 'gasSafeRegistration')),
    publicLiabilityExpiry: textOrNull(pick('public_liability_expiry', 'publicLiabilityExpiry')),
    dbsType: textOrNull(pick('dbs_type', 'dbsType')),
    dbsExpiryDate: textOrNull(pick('dbs_expiry_date', 'dbsExpiryDate')),
  };
}

/** GET /api/contractors, read in either field style. */
export function normalizeContractors(value: unknown): ContractorRecord[] {
  return rowsOf(value).map(normalizeContractorRow).filter((row) => Number.isSafeInteger(row.id));
}

/** GET /api/contractors/:id; null when the answer is not a contractor. */
export function normalizeContractor(value: unknown): ContractorRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = normalizeContractorRow(value as Row);
  return Number.isSafeInteger(row.id) ? row : null;
}

export function normalizeCertificates(value: unknown): ContractorCertificate[] {
  return rowsOf(value).map((row) => {
    const pick = picker(row);
    return {
      id: Number(row.id),
      name: String(pick('certificate_name', 'certificateName') ?? 'Certificate'),
      issuer: textOrNull(row.issuer),
      completedDate: textOrNull(pick('completed_date', 'completedDate')),
      expiryDate: textOrNull(pick('expiry_date', 'expiryDate')),
      notes: textOrNull(row.notes),
    };
  }).filter((cert) => Number.isSafeInteger(cert.id));
}

export function normalizeQueueItems(value: unknown): ContractorEmailQueueItem[] {
  return rowsOf(value).map((row) => {
    const pick = picker(row);
    const preview = pick('email_preview_json', 'emailPreviewJson');
    const p: Row = preview && typeof preview === 'object' ? preview as Row : {};
    return {
      id: Number(row.id),
      emailType: String(pick('email_type', 'emailType') ?? 'assignment'),
      createdAt: textOrNull(pick('created_at', 'createdAt')),
      requestedBy: textOrNull(pick('requested_by', 'requestedBy')),
      subject: String(p.subject ?? ''),
      text: String(p.text ?? ''),
      siteName: textOrNull(pick('site_name', 'siteName')),
      contractorName: textOrNull(pick('contractor_name', 'contractorName')),
      jobTitle: textOrNull(pick('job_title', 'jobTitle') ?? pick('item_title', 'itemTitle')),
    };
  }).filter((item) => Number.isSafeInteger(item.id));
}

export function normalizeChecks(value: unknown): ContractorCheck[] {
  return rowsOf(value).map((row) => {
    const pick = picker(row);
    return {
      id: Number(row.id),
      title: String(row.title ?? 'Compliance check'),
      status: String(row.status ?? 'pending'),
      dueDate: textOrNull(pick('due_date', 'dueDate')),
    };
  }).filter((item) => Number.isSafeInteger(item.id));
}

/** The website's StatusBadge wording for compliance checks. */
export function checkStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending', in_progress: 'In Progress', completed: 'Completed', overdue: 'Overdue',
  };
  return labels[status] ?? status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export type ContractorStatusLevel = 'complete' | 'expiring' | 'missing-or-expired';

/** Badge colour for each list level (green, amber, red). */
export const CONTRACTOR_STATUS_COLOR: Record<ContractorStatusLevel, string> = {
  complete: '#059669',
  expiring: '#d97706',
  'missing-or-expired': '#dc2626',
};

export interface ContractorListStatus {
  level: ContractorStatusLevel;
  problems: string[];
}

/** The website's list labels (pages/contractors.tsx). */
export const CONTRACTOR_STATUS_LABEL: Record<ContractorStatusLevel, string> = {
  complete: 'Up to date',
  expiring: 'Expiring soon',
  'missing-or-expired': 'Missing or expired',
};

/** Whole calendar days from today (device date) to a stored date; null if missing or not a real date. */
export function daysUntilExpiry(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  // DB timestamps and date inputs both begin with YYYY-MM-DD. Compare calendar
  // dates, so an expiry remains valid through its last day.
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const expiry = Date.UTC(year, month - 1, day);
  if (new Date(expiry).toISOString().slice(0, 10) !== date) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((expiry - today) / 86_400_000);
}

/** Same rules as the website's contractor list: insurance, DBS / PVG and Gas Safe. */
export function contractorListStatus(contractor: ContractorRecord, now = new Date()): ContractorListStatus {
  const problems: string[] = [];
  let expiredOrMissing = false;
  let expiring = false;

  for (const [label, value] of [
    ['Public liability insurance', contractor.publicLiabilityExpiry],
    ['DBS / PVG check', contractor.dbsExpiryDate],
  ] as const) {
    const days = daysUntilExpiry(value, now);
    if (days === null) {
      problems.push(`${label}: missing expiry date`);
      expiredOrMissing = true;
    } else if (days < 0) {
      problems.push(`${label}: expired`);
      expiredOrMissing = true;
    } else if (days <= 30) {
      problems.push(`${label}: expiring ${days === 0 ? 'today' : `in ${days} days`}`);
      expiring = true;
    }
  }

  if (!contractor.gasSafeRegistration?.trim()) {
    problems.push('Gas Safe registration: missing');
    expiredOrMissing = true;
  }

  return {
    level: expiredOrMissing ? 'missing-or-expired' : expiring ? 'expiring' : 'complete',
    problems,
  };
}

/** Search by name or company, optionally only missing or expired (the website's filter button). */
export function filterContractors(
  contractors: readonly ContractorRecord[],
  search: string,
  missingOrExpiredOnly: boolean,
  now = new Date(),
): ContractorRecord[] {
  const term = search.trim().toLowerCase();
  return contractors.filter((contractor) => {
    const matches = !term || contractor.name.toLowerCase().includes(term)
      || Boolean(contractor.company?.toLowerCase().includes(term));
    return matches && (!missingOrExpiredOnly || contractorListStatus(contractor, now).level === 'missing-or-expired');
  });
}

export function countMissingOrExpired(contractors: readonly ContractorRecord[], now = new Date()): number {
  return contractors.filter((contractor) => contractorListStatus(contractor, now).level === 'missing-or-expired').length;
}

export type CertificateExpiryLevel = 'none' | 'expired' | 'expiring' | 'valid';

/** The website's ExpiryBadge: No Expiry, Expired, Expiring Soon (Nd), Valid. */
export function certificateExpiry(expiry: string | null | undefined, now = new Date()): { level: CertificateExpiryLevel; label: string } {
  if (!expiry) return { level: 'none', label: 'No Expiry' };
  const days = daysUntilExpiry(expiry, now);
  if (days === null) return { level: 'none', label: 'No Expiry' };
  if (days < 0) return { level: 'expired', label: 'Expired' };
  if (days <= 30) return { level: 'expiring', label: `Expiring Soon (${days}d)` };
  return { level: 'valid', label: 'Valid' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "20 Oct 2026" from a stored date or timestamp; null when missing or not a date. */
export function formatDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${Number(match[3])} ${MONTHS[month - 1]} ${match[1]}`;
}

/** tel: link for the phone dialler, keeping only dialable characters; null when there is no number. */
export function telUrl(phone: string | null | undefined): string | null {
  const dialable = String(phone ?? '').replace(/[^\d+#*]/g, '');
  return /\d{3,}/.test(dialable) ? `tel:${dialable}` : null;
}

/** mailto: link for the mail app; null unless it looks like one address. */
export function mailtoUrl(email: string | null | undefined): string | null {
  const address = String(email ?? '').trim();
  return /^[^\s@,;?]+@[^\s@,;?]+\.[^\s@,;?]+$/.test(address) ? `mailto:${address}` : null;
}

// ── Contractor email approvals ──────────────────────────────────────────────

export const CANCELLATION_APPROVAL_CONFIRMATION =
  'Approve this calendar cancellation? It will send the contractor a cancellation notice and remove the previously sent calendar event.';

export const CANCELLATION_DISMISS_CONFIRMATION =
  'Dismiss this calendar cancellation? Nothing will be sent and the existing calendar event will remain in place.';

export const EMAIL_DISMISS_CONFIRMATION = 'Are you sure you want to cancel this email request?';

export function isCancellation(item: Pick<ContractorEmailQueueItem, 'emailType'>): boolean {
  return item.emailType === 'cancellation';
}

/** The website's tag for each queued email. */
export function emailTypeLabel(item: Pick<ContractorEmailQueueItem, 'emailType'>): string {
  if (isCancellation(item)) return 'Calendar Cancellation';
  if (item.emailType === 'quote_request') return 'Requesting Quote';
  if (item.emailType === 'reminder') return 'Reminder';
  return 'Assigning Job';
}

export type ApprovalAction = 'approve' | 'dismiss';

/**
 * What the website asks before an action: cancellations are always
 * confirmed, ordinary emails only when cancelling. null = no question.
 */
export function approvalConfirmation(item: Pick<ContractorEmailQueueItem, 'emailType'>, action: ApprovalAction): string | null {
  if (action === 'approve') return isCancellation(item) ? CANCELLATION_APPROVAL_CONFIRMATION : null;
  return isCancellation(item) ? CANCELLATION_DISMISS_CONFIRMATION : EMAIL_DISMISS_CONFIRMATION;
}

/** The existing manager endpoints (online-only: they send or withdraw an email now). */
export function approvalRequest(itemId: number, action: ApprovalAction): { path: string; init: { method: 'POST'; body?: string } } {
  return action === 'approve'
    ? { path: `/api/fix-track/contractor-email-queue/${itemId}/approve-and-send`, init: { method: 'POST', body: '{}' } }
    : { path: `/api/fix-track/contractor-email-queue/${itemId}/cancel`, init: { method: 'POST' } };
}

export function approvalSuccessMessage(item: Pick<ContractorEmailQueueItem, 'emailType'>, action: ApprovalAction): string {
  if (action === 'approve') return isCancellation(item) ? 'Calendar cancellation approved and sent' : 'Email approved and sent';
  return isCancellation(item) ? 'Calendar cancellation dismissed' : 'Email cancelled';
}

export function approvalButtonLabel(item: Pick<ContractorEmailQueueItem, 'emailType'>, action: ApprovalAction): string {
  if (action === 'approve') return isCancellation(item) ? 'Approve Cancellation' : 'Approve & Send';
  return isCancellation(item) ? 'Dismiss' : 'Cancel';
}

/** Group by site name like the website ("No Site" for none), sites A–Z, newest first within a site. */
export function groupApprovalsBySite<T extends Pick<ContractorEmailQueueItem, 'siteName'>>(items: readonly T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const site = item.siteName || 'No Site';
    map.set(site, [...(map.get(site) ?? []), item]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Who may see and act on the approvals queue on the phone (the API also lets maintenance managers in). */
export function canApproveContractorEmails(role: string | null | undefined): boolean {
  return role === 'client_admin' || role === 'consultant';
}
