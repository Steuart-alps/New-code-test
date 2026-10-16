/**
 * "Hand the phone to staff to sign" (app/manage/staff-sign-off.tsx): the
 * website's staff sign-off page (compliance-tracker src/pages/sign-off.tsx)
 * on a manager's phone. Staff without their own login pick their department
 * and name, then read and sign the documents that need their acknowledgement.
 *
 * It uses the same API as the website page: the account's sign-off link token
 * from GET /api/doc-track/sign-off-info (client admins and consultants), then
 * the token-protected /api/sign-off/:token/* routes, which derive each staff
 * member's documents from their roster record on the server. Signing is
 * internet-only: nothing is queued on the phone.
 *
 * Import-free so tests can load it with Node.
 */

export type SignOffDocumentType = 'doc' | 'ra' | 'sop' | 'handbook';

export interface SignOffStaff {
  id: number;
  name: string;
  jobTitle: string | null;
  department: string | null;
}

export interface SignOffDoc {
  documentType: SignOffDocumentType;
  id: number;
  title: string;
  category: string;
  description: string | null;
  fileName: string | null;
  department: string | null;
  hasFile: boolean;
  signed: boolean;
  acknowledgedAt: string | null;
}

/** Department choice meaning "every active staff member" (no department filter). */
export const ALL_STAFF = '__all__';

/** Same labels as the website sign-off page. */
export const CATEGORY_LABELS: Record<string, string> = {
  risk_assessment: 'Risk Assessment',
  sop: 'SOP',
  handbook: 'Handbook',
  policy: 'Policy',
  procedure: 'Procedure',
  other: 'Document',
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return CATEGORY_LABELS.other;
  return CATEGORY_LABELS[category] ?? category;
}

type Raw = Record<string, unknown>;
function picker(raw: unknown) {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  return (snake: string, camel: string): unknown => item[snake] ?? item[camel];
}
const text = (value: unknown): string | null =>
  value === null || value === undefined || value === '' ? null : String(value);

const DOCUMENT_TYPES: SignOffDocumentType[] = ['doc', 'ra', 'sop', 'handbook'];

/** A staff row of GET /api/sign-off/:token/staff, in snake_case or camelCase. */
export function toSignOffStaff(raw: unknown): SignOffStaff {
  const pick = picker(raw);
  return {
    id: Number(pick('id', 'id')),
    name: String(pick('name', 'name') ?? ''),
    jobTitle: text(pick('job_title', 'jobTitle')),
    department: text(pick('department', 'department')),
  };
}

/** A document row of GET /api/sign-off/:token/documents, in snake_case or camelCase. */
export function toSignOffDoc(raw: unknown): SignOffDoc {
  const pick = picker(raw);
  const type = String(pick('document_type', 'documentType') ?? 'doc') as SignOffDocumentType;
  return {
    documentType: DOCUMENT_TYPES.includes(type) ? type : 'doc',
    id: Number(pick('id', 'id')),
    title: String(pick('title', 'title') ?? ''),
    category: String(pick('category', 'category') ?? 'other'),
    description: text(pick('description', 'description')),
    fileName: text(pick('file_name', 'fileName')),
    department: text(pick('department', 'department')),
    hasFile: Boolean(pick('has_file', 'hasFile')),
    signed: Boolean(pick('signed', 'signed')),
    acknowledgedAt: text(pick('acknowledged_at', 'acknowledgedAt')),
  };
}

/** Paths of the website sign-off page's API, for one sign-off link token. */
export function signOffPaths(token: string) {
  const base = `/api/sign-off/${encodeURIComponent(token)}`;
  return {
    info: `${base}/info`,
    departments: `${base}/departments`,
    staff: (department: string) => department === ALL_STAFF
      ? `${base}/staff`
      : `${base}/staff?department=${encodeURIComponent(department)}`,
    documents: (staffId: number) => `${base}/documents?staffId=${staffId}`,
    download: (doc: Pick<SignOffDoc, 'id' | 'documentType'>, staffId: number) =>
      `${base}/documents/${doc.id}/download?documentType=${encodeURIComponent(doc.documentType)}&staffId=${staffId}`,
    acknowledge: `${base}/acknowledge`,
  };
}

/** The website requires at least two characters for a typed-name signature. */
export function canSignWithTypedName(typedName: string): boolean {
  return typedName.trim().length >= 2;
}

/** POST /api/sign-off/:token/acknowledge body, as the website sends a typed signature. */
export function buildAcknowledgeBody(
  doc: Pick<SignOffDoc, 'id' | 'documentType'>,
  staffId: number,
  typedName: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!canSignWithTypedName(typedName)) return { ok: false, error: 'Type your full name to confirm.' };
  return {
    ok: true,
    body: {
      documentId: doc.id,
      documentType: doc.documentType,
      staffRosterId: staffId,
      signature: null,
      typedName: typedName.trim(),
    },
  };
}

export interface SignOffProgress {
  signed: number;
  total: number;
  unsigned: number;
  allSigned: boolean;
  /** "2 documents need your signature", or null when none are outstanding. */
  message: string | null;
}

export function signOffProgress(docs: readonly Pick<SignOffDoc, 'signed'>[]): SignOffProgress {
  const signed = docs.filter((doc) => doc.signed).length;
  const unsigned = docs.length - signed;
  return {
    signed,
    total: docs.length,
    unsigned,
    allSigned: docs.length > 0 && unsigned === 0,
    message: unsigned > 0
      ? `${unsigned} document${unsigned > 1 ? 's' : ''} need${unsigned === 1 ? 's' : ''} your signature`
      : null,
  };
}

/** "Signed 05 Oct 2026" as on the website. */
export function signedDateLabel(acknowledgedAt: string | null): string | null {
  if (!acknowledgedAt) return null;
  const date = new Date(acknowledgedAt);
  if (Number.isNaN(date.getTime())) return null;
  return `Signed ${date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
}

/** Whether a sign-off-info error means there is no active link (404), rather than a failure. */
export function isMissingSignOffLink(error: unknown): boolean {
  return !!error && typeof error === 'object' && Number((error as { status?: unknown }).status) === 404;
}

/** Only client admins and consultants can read the sign-off link (requireClientAdmin). */
export function canHandPhoneToStaff(role: string | null | undefined): boolean {
  return role === 'client_admin' || role === 'consultant';
}

/** The sign-off routes read DocTrack and SafeTrack documents (requireAnyService). */
export function hasSignOffService(hasService: (key: string) => boolean): boolean {
  return hasService('doctrack') || hasService('safetrack');
}

export type KioskStep = 'department' | 'staff' | 'documents' | 'sign';

/** The step a staff member is on; hardware back walks these in reverse. */
export function kioskStep(state: { department: string | null; staffId: number | null; signing: boolean }): KioskStep {
  if (state.signing && state.staffId !== null) return 'sign';
  if (state.staffId !== null) return 'documents';
  return state.department !== null ? 'staff' : 'department';
}
