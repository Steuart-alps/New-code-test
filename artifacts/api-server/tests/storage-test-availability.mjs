const STORAGE_UNAVAILABLE_STATUS = 503;
const STORAGE_UNAVAILABLE_CODE = "OBJECT_STORAGE_UNAVAILABLE";
const STORAGE_UNAVAILABLE_MESSAGE = "File uploads are temporarily unavailable. Please try again later.";

/**
 * Classifies only upload-signing failures that identify object storage as the
 * cause. Unexpected server errors and API contract failures must still fail.
 */
export function getStorageUnavailableSkipReason(response, suiteName) {
  if (response?.status !== STORAGE_UNAVAILABLE_STATUS) return null;
  if (response?.data?.code !== STORAGE_UNAVAILABLE_CODE) return null;
  if (response.data.error !== STORAGE_UNAVAILABLE_MESSAGE) return null;
  if (Object.keys(response.data).some((key) => key !== "error" && key !== "code")) return null;
  return `${suiteName} requires object storage; upload reservation returned HTTP ${response.status} (${response.data.error})`;
}

export function skipWhenStorageUnavailable(response, suiteName) {
  const reason = getStorageUnavailableSkipReason(response, suiteName);
  if (!reason) return false;
  console.log(`SKIP: ${reason}`);
  return true;
}