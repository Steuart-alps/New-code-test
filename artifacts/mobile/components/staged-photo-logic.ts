/**
 * Pure logic for staged required-photo evidence on new GreenTrack and
 * SwimTrack records. It follows the same API contract as the web app:
 *
 *   1. POST /api/photos/request-staged-upload  (bearer-authenticated API call)
 *   2. PUT the bytes to the returned signed URL (object storage: no credentials)
 *   3. POST /api/photos/staged                  (server verifies, returns a receipt)
 *   4. create the record with photoUploadIds    (server claims receipts atomically)
 *
 * This file has no imports so node tests can transpile and run it directly.
 */

export const STAGED_PHOTO_MAX = 10;
export const STAGED_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** Server receipts expire 30 minutes after verification. */
export const STAGED_RECEIPT_TTL_MS = 30 * 60 * 1000;
/** Treat a receipt as expired slightly early so a slow save is not rejected. */
export const STAGED_RECEIPT_SAFETY_MS = 2 * 60 * 1000;

export type StagedPhotoContentType = 'image/jpeg' | 'image/png';

export interface PhotoRequirement {
  required: boolean;
  minPhotos: number;
}

export interface StagedPhoto {
  id: string;
  name: string;
  uri: string;
  stagedAt: number;
}

export interface StagedPhotoAsset {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStagedReceiptId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Staged receipts belong to one signed-in user in one client for one record
 * type. Any change to that identity must discard local receipts: the server
 * would reject them, and they must never be offered to a different account.
 */
export function stagedPhotoScope(
  userId: number | null | undefined,
  clientId: number | null | undefined,
  entityType: string,
): string | null {
  if (typeof userId !== 'number' || !Number.isFinite(userId)) return null;
  return `${userId}:${clientId ?? 'none'}:${entityType}`;
}

export function parsePhotoRequirements(rows: unknown): Record<string, PhotoRequirement> {
  if (!Array.isArray(rows)) throw new Error('Invalid photo requirements response.');
  const requirements: Record<string, PhotoRequirement> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Invalid photo requirement. Please retry.');
    const { entity_type: entityType, required, min_photos: minPhotos } = row as Record<string, unknown>;
    if (typeof entityType !== 'string' || typeof required !== 'boolean'
      || typeof minPhotos !== 'number' || !Number.isInteger(minPhotos) || minPhotos < 1 || minPhotos > STAGED_PHOTO_MAX) {
      throw new Error('Invalid photo requirement. Please retry.');
    }
    requirements[entityType] = { required, minPhotos };
  }
  return requirements;
}

export function requirementFor(
  requirements: Record<string, PhotoRequirement> | undefined,
  entityType: string,
): { required: boolean; minimum: number } {
  const rule = requirements?.[entityType];
  return { required: rule?.required ?? false, minimum: rule?.required ? rule.minPhotos : 0 };
}

export function validatePhotoAsset(
  asset: StagedPhotoAsset,
): { contentType: StagedPhotoContentType; name: string } | { error: string } {
  const mime = (asset.mimeType ?? '').toLowerCase();
  const lowerName = (asset.fileName ?? asset.uri ?? '').toLowerCase();
  const contentType: StagedPhotoContentType | null = mime === 'image/jpeg' || mime === 'image/jpg'
    ? 'image/jpeg'
    : mime === 'image/png'
      ? 'image/png'
      : !mime && /\.(jpe?g)$/.test(lowerName)
        ? 'image/jpeg'
        : !mime && /\.png$/.test(lowerName)
          ? 'image/png'
          : null;
  if (!contentType) return { error: 'Choose a JPEG or PNG photo.' };
  if (typeof asset.fileSize === 'number' && asset.fileSize > STAGED_PHOTO_MAX_BYTES) {
    return { error: 'Choose a photo no larger than 10 MB.' };
  }
  const name = (asset.fileName ?? '').trim().slice(0, 200)
    || `photo-${Date.now()}.${contentType === 'image/png' ? 'png' : 'jpg'}`;
  return { contentType, name };
}

export interface StagePhotoDeps {
  /** Bearer-authenticated JSON POST to the ComplyTrack API. */
  apiPost(path: string, body: Record<string, unknown>): Promise<unknown>;
  /**
   * PUT the local file to object storage. Implementations must send only the
   * Content-Type header and no cookies: session credentials never go to storage.
   */
  putObject(uploadUrl: string, headers: { 'Content-Type': StagedPhotoContentType }, uri: string): Promise<{ ok: boolean; status: number }>;
  now?: () => number;
}

/** Only accept a signed HTTPS storage URL: never upload over cleartext. */
export function isSafeUploadUrl(value: unknown): value is string {
  // A regex rather than URL parsing keeps this identical across Hermes builds.
  // The authority may not contain userinfo ("@") or whitespace.
  return typeof value === 'string' && value.length <= 8192 && /^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(value);
}

export async function stageRequiredPhoto(
  deps: StagePhotoDeps,
  entityType: string,
  asset: StagedPhotoAsset,
): Promise<StagedPhoto> {
  const checked = validatePhotoAsset(asset);
  if ('error' in checked) throw new Error(checked.error);
  const upload = await deps.apiPost('/api/photos/request-staged-upload', {
    entityType,
    name: checked.name,
    contentType: checked.contentType,
  }) as { uploadUrl?: unknown; objectPath?: unknown } | undefined;
  if (!upload || !isSafeUploadUrl(upload.uploadUrl) || typeof upload.objectPath !== 'string' || !upload.objectPath) {
    throw new Error('Invalid photo upload response.');
  }
  const put = await deps.putObject(upload.uploadUrl, { 'Content-Type': checked.contentType }, asset.uri);
  if (!put.ok) throw new Error('Upload to storage failed. Please retry.');
  const staged = await deps.apiPost('/api/photos/staged', {
    entityType,
    objectPath: upload.objectPath,
  }) as { id?: unknown } | undefined;
  if (!staged || !isStagedReceiptId(staged.id)) throw new Error('Invalid photo verification response.');
  return { id: staged.id, name: checked.name, uri: asset.uri, stagedAt: (deps.now ?? Date.now)() };
}

export function splitExpiredPhotos(
  photos: StagedPhoto[],
  now: number,
): { fresh: StagedPhoto[]; expired: StagedPhoto[] } {
  const limit = STAGED_RECEIPT_TTL_MS - STAGED_RECEIPT_SAFETY_MS;
  const fresh: StagedPhoto[] = [];
  const expired: StagedPhoto[] = [];
  for (const photo of photos) (now - photo.stagedAt < limit ? fresh : expired).push(photo);
  return { fresh, expired };
}

export interface EvidenceStatusInput {
  enabled: boolean;
  loading: boolean;
  loadFailed: boolean;
  uploading: boolean;
  required: boolean;
  minimum: number;
  photoCount: number;
}

/**
 * Whether the form may submit. When requirements cannot be loaded (for
 * example, offline) saving stays possible: the server enforces the rule and
 * a 422 is shown with the draft intact, so optional saves are never blocked
 * by a failed preflight.
 */
export function evidenceReady(input: EvidenceStatusInput): boolean {
  if (!input.enabled) return true;
  if (input.uploading) return false;
  if (input.loadFailed) return true;
  if (input.loading) return false;
  return !input.required || input.photoCount >= input.minimum;
}

/**
 * Add receipts to a create payload. Optional saves without photos keep their
 * original body exactly, so existing optional-photo creates are unchanged.
 */
export function withPhotoUploadIds<T extends Record<string, unknown>>(
  payload: T,
  photos: StagedPhoto[],
): T & { photoUploadIds?: string[] } {
  if (!photos.length) return payload;
  return { ...payload, photoUploadIds: photos.slice(0, STAGED_PHOTO_MAX).map((photo) => photo.id) };
}

export type StagedCreateFailure = 'receipts-invalid' | 'requirement' | 'network' | 'other';

export function classifyStagedCreateError(error: unknown): StagedCreateFailure {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : '';
  if (typeof status !== 'number') return 'network';
  if (status === 422) return 'requirement';
  if ((status === 400 || status === 403) && /photo upload receipt|photoUploadIds/i.test(message)) {
    return 'receipts-invalid';
  }
  return 'other';
}

export function stagedCreateErrorMessage(kind: StagedCreateFailure, fallback: string): string {
  switch (kind) {
    case 'receipts-invalid':
      return 'The attached photos are no longer valid. If your earlier save went through it will appear in recent records; otherwise add the photos again and resubmit. Your other answers have been kept.';
    case 'requirement':
      return `${fallback.replace(/\.?\s*$/, '.')} Add the required photos and try again. Your answers have been kept.`;
    case 'network':
      return 'The connection failed before the record was confirmed. Your answers and photos have been kept, so you can try again.';
    default:
      return fallback;
  }
}
