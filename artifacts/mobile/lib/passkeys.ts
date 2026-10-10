import { Platform } from 'react-native';
import type * as NativePasskeys from 'react-native-passkeys';
import { ApiError, apiFetch } from './api';
import {
  classifyPasskeyError,
  passkeyFailureMessage,
  type PasskeyFailure,
} from './passkeyErrors';

/**
 * Native passkeys (iOS 16+, Android 9+) for the installed ComplyTrack app.
 *
 * A passkey takes the place of the email and password only. The server answers
 * a verified passkey exactly as it answers a correct password: with the
 * mandatory authenticator-code step, or with the web two-factor setup link.
 *
 * Expo Go and the web build have no native passkey module, so it is loaded
 * lazily and every caller must handle passkeys being unavailable.
 */

type PasskeysModule = typeof NativePasskeys;

let cachedModule: PasskeysModule | null | undefined;

function loadNativePasskeys(): PasskeysModule | null {
  if (cachedModule !== undefined) return cachedModule;
  cachedModule = null;
  if (Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) < 16) return null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // Requiring the module throws where the native code is missing (Expo Go).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passkeys = require('react-native-passkeys') as PasskeysModule;
    if (passkeys.isSupported()) cachedModule = passkeys;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export function nativePasskeysAvailable(): boolean {
  return loadNativePasskeys() !== null;
}

/** The web settings page, where a passkey can be added from any browser. */
export function defaultWebPasskeySetupUrl(): string | null {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  return domain ? `https://${domain}/settings` : null;
}

export class PasskeyFlowError extends Error {
  constructor(
    public readonly reason: PasskeyFailure,
    message: string,
    public readonly webSetupUrl: string | null,
  ) {
    super(message);
    this.name = 'PasskeyFlowError';
  }
}

function unavailable(): PasskeyFlowError {
  return new PasskeyFlowError(
    'unsupported',
    passkeyFailureMessage('unsupported'),
    defaultWebPasskeySetupUrl(),
  );
}

interface CeremonyStart<Options> {
  challengeToken: string;
  options: Options;
  webSetupUrl?: string;
}

export type PasskeySignInResult =
  | { pendingToken: string }
  | { requires2faSetup: true; setupUrl?: string };

/** Runs the phone's passkey prompt and returns the server's next step. */
export async function signInWithPasskey(): Promise<PasskeySignInResult> {
  const passkeys = loadNativePasskeys();
  if (!passkeys) throw unavailable();

  const start = await apiFetch<CeremonyStart<Parameters<PasskeysModule['get']>[0]>>(
    '/api/auth/mobile-passkeys/authentication/options',
    { method: 'POST', body: '{}' },
  );
  const webSetupUrl = start.webSetupUrl ?? defaultWebPasskeySetupUrl();

  let credential: Awaited<ReturnType<PasskeysModule['get']>>;
  try {
    credential = await passkeys.get(start.options);
  } catch (error: unknown) {
    const reason = classifyPasskeyError(error);
    throw new PasskeyFlowError(reason, passkeyFailureMessage(reason), webSetupUrl);
  }
  if (!credential) {
    throw new PasskeyFlowError('cancelled', passkeyFailureMessage('cancelled'), webSetupUrl);
  }

  try {
    return await apiFetch<PasskeySignInResult>('/api/auth/mobile-passkeys/authenticate', {
      method: 'POST',
      body: JSON.stringify({ challengeToken: start.challengeToken, credential }),
    });
  } catch (error: unknown) {
    // A passkey saved for this domain but not (or no longer) on the account,
    // e.g. one removed on the web, needs the same setup help as no passkey.
    if (error instanceof ApiError && /not registered/i.test(error.message)) {
      throw new PasskeyFlowError('no-passkey', error.message, webSetupUrl);
    }
    throw error;
  }
}

/** Adds a passkey on this phone for the signed-in user. */
export async function addPasskeyOnThisPhone(): Promise<void> {
  const passkeys = loadNativePasskeys();
  if (!passkeys) throw unavailable();

  const start = await apiFetch<CeremonyStart<Parameters<PasskeysModule['create']>[0]>>(
    '/api/auth/mobile-passkeys/registration/options',
    { method: 'POST', body: '{}' },
  );

  let credential: Awaited<ReturnType<PasskeysModule['create']>>;
  try {
    credential = await passkeys.create(start.options);
  } catch (error: unknown) {
    const reason = classifyPasskeyError(error);
    throw new PasskeyFlowError(
      reason,
      reason === 'cancelled' ? 'No passkey was added.' : passkeyFailureMessage(reason),
      defaultWebPasskeySetupUrl(),
    );
  }
  if (!credential) {
    throw new PasskeyFlowError('cancelled', 'No passkey was added.', defaultWebPasskeySetupUrl());
  }

  // JSON serialisation drops the library's getPublicKey() helper.
  await apiFetch('/api/auth/mobile-passkeys/registration/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeToken: start.challengeToken, credential }),
  });
}

export interface PasskeySummary {
  id: number;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const data = await apiFetch<{ passkeys: PasskeySummary[] }>('/api/auth/passkeys');
  return data.passkeys;
}
