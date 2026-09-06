import AsyncStorage from '@react-native-async-storage/async-storage';

export interface RecoveryIdentity {
  userId: number;
  clientId: number;
}

export const PENDING_ISSUE_UPLOAD_KEY_PREFIX = 'fix-track-pending-issue-upload:';

/**
 * Recovery data is deliberately partitioned by both authenticated identities.
 * Do not use an email address here: it can change while the numeric identity
 * remains authoritative.
 */
export function pendingIssueUploadKey(identity: RecoveryIdentity): string {
  return `${PENDING_ISSUE_UPLOAD_KEY_PREFIX}${identity.clientId}:${identity.userId}`;
}

/** Clear every pending FixTrack recovery record when this device is signed out. */
export async function clearPendingIssueUploadRecovery(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const recoveryKeys = keys.filter((key) => key.startsWith(PENDING_ISSUE_UPLOAD_KEY_PREFIX));
  if (recoveryKeys.length > 0) await AsyncStorage.multiRemove(recoveryKeys);
}

/** Remove another account's records while preserving the account signing in. */
export async function clearOtherPendingIssueUploadRecovery(identity: RecoveryIdentity): Promise<void> {
  const keepKey = pendingIssueUploadKey(identity);
  const keys = await AsyncStorage.getAllKeys();
  const recoveryKeys = keys.filter(
    (key) => key.startsWith(PENDING_ISSUE_UPLOAD_KEY_PREFIX) && key !== keepKey,
  );
  if (recoveryKeys.length > 0) await AsyncStorage.multiRemove(recoveryKeys);
}