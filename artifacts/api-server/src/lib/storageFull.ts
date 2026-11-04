/**
 * The refusal an upload gets when its business has used all the storage it
 * pays for (see storageLimit.ts). Kept free of imports so upload routes,
 * settings and objectStorageUnavailable.ts can use it without pulling in billing.
 */
/** App setting: "true" tops storage up automatically instead of stopping uploads. */
export const STORAGE_AUTO_TOP_UP_SETTING = "storageAutoTopUp";

export const STORAGE_FULL_CODE = "STORAGE_FULL";
export const STORAGE_FULL_MESSAGE =
  "This business's ComplyTrack storage is full, so new files can't be uploaded. Nothing has been deleted. An owner can add more storage in Settings, under File storage.";
/** For people outside the business (contractors, public completion links). */
export const STORAGE_FULL_EXTERNAL_MESSAGE =
  "Files can't be uploaded to this business right now because its ComplyTrack storage is full. Please let your contact there know.";

export class StorageFullError extends Error {
  readonly code = STORAGE_FULL_CODE;
  constructor() {
    super(STORAGE_FULL_MESSAGE);
    this.name = "StorageFullError";
  }
}
