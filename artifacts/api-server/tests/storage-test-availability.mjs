const STORAGE_UNAVAILABLE_STATUS = new Set([500, 502, 503]);
const STORAGE_UNAVAILABLE_MESSAGE = /(?:could not|failed to) generate upload url|object storage|storage bucket|bucket.*(?:missing|unavailable|not configured)/i;

/**
 * Classifies only upload-signing failures that identify object storage as the
 * cause. Unexpected server errors and API contract failures must still fail.
 */
export function getStorageUnavailableSkipReason(response, suiteName) {
  if (!STORAGE_UNAVAILABLE_STATUS.has(response?.status)) return null;
  const message = [response?.data?.error, response?.data?.detail]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(": ");
  if (!STORAGE_UNAVAILABLE_MESSAGE.test(message)) return null;
  return `${suiteName} requires object storage; upload reservation returned HTTP ${response.status}${message ? ` (${message})` : ""}`;
}

export function skipWhenStorageUnavailable(response, suiteName) {
  const reason = getStorageUnavailableSkipReason(response, suiteName);
  if (!reason) return false;
  console.log(`SKIP: ${reason}`);
  return true;
}