/**
 * Plain-language outcomes for a native passkey prompt. iOS reports errors as
 * Expo exceptions (codes such as ERR_USER_CANCELLED), Android's Credential
 * Manager as messages such as "NoCredentials". iOS also shows its own "no
 * passkeys" sheet, which comes back as a cancel, so a cancel is answered with
 * the same setup help as a missing passkey.
 */
export type PasskeyFailure =
  | 'cancelled'
  | 'no-passkey'
  | 'not-configured'
  | 'unsupported'
  | 'failed';

export function classifyPasskeyError(error: unknown): PasskeyFailure {
  const parts: string[] = [];
  if (error && typeof error === 'object') {
    for (const key of ['code', 'name', 'message']) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string') parts.push(value);
    }
  } else if (typeof error === 'string') {
    parts.push(error);
  }
  const text = parts.join(' ').toLowerCase().replace(/[_\s-]+/g, '');

  if (text.includes('nocredential') || text.includes('nopasskey')) return 'no-passkey';
  if (text.includes('cancel') || text.includes('notallowed')) return 'cancelled';
  if (text.includes('notconfigured') || text.includes('notassociated') || text.includes('associateddomain')) {
    return 'not-configured';
  }
  if (text.includes('notsupported') || text.includes('unsupported')) return 'unsupported';
  return 'failed';
}

export function passkeyFailureMessage(reason: PasskeyFailure): string {
  switch (reason) {
    case 'cancelled':
      return 'No passkey was used.';
    case 'no-passkey':
      return 'There is no ComplyTrack passkey saved on this phone.';
    case 'not-configured':
      return 'Passkeys are not available in this version of the app yet. Sign in with your email and password.';
    case 'unsupported':
      return 'This phone does not support passkeys. Sign in with your email and password.';
    default:
      return 'Passkey sign-in did not work. Please try again or sign in with your email and password.';
  }
}

/** Outcomes where the person most likely needs to add a passkey first. */
export function passkeyFailureNeedsSetup(reason: PasskeyFailure): boolean {
  return reason === 'cancelled' || reason === 'no-passkey';
}
