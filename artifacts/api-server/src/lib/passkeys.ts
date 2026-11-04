import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";
import { passkeysTable } from "@workspace/db/schema";
import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getPublicAppUrl } from "./email";

export const PASSKEY_RP_NAME = "ComplyTrack";

export function getPasskeyRpId(): string {
  const configured = process.env.PASSKEY_RP_ID?.trim();
  if (configured) return configured;
  return new URL(getPublicAppUrl()).hostname;
}

export function getPasskeyOrigin(): string {
  const configured = process.env.PASSKEY_ORIGIN?.trim();
  if (configured) return configured;
  return getPublicAppUrl();
}

export function encodePasskeyBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function decodePasskeyBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export async function getUserPasskeys(userId: number) {
  return db.select().from(passkeysTable).where(eq(passkeysTable.userId, userId));
}

export async function hasUserPasskey(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: passkeysTable.id })
    .from(passkeysTable)
    .where(eq(passkeysTable.userId, userId))
    .limit(1);
  return Boolean(row);
}

export function registrationOptionsForUser(
  user: { id: number; email: string; name: string },
  existing: Array<{ credentialId: string; transports: string[] | null }>,
) {
  const options = {
    rpName: PASSKEY_RP_NAME,
    rpID: getPasskeyRpId(),
    userName: user.email,
    userDisplayName: user.name,
    userID: new Uint8Array(Buffer.from(String(user.id))),
    attestationType: "none" as const,
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: (credential.transports ?? []) as any,
    })),
    authenticatorSelection: {
      residentKey: "preferred" as const,
      userVerification: "preferred" as const,
    },
  };
  return generateRegistrationOptions(options);
}

export function authenticationOptionsForUser(
  credentials: Array<{ credentialId: string; transports: string[] | null }>,
) {
  const options = {
    rpID: getPasskeyRpId(),
    userVerification: "preferred" as const,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: (credential.transports ?? []) as any,
    })),
  };
  return generateAuthenticationOptions(options);
}
// ─── Native mobile passkeys ──────────────────────────────────────────────────
// The Expo app uses the platform passkey APIs with the web app's RP ID, so a
// passkey saved to iCloud Keychain or Google Password Manager works in both.
// iOS reports the https origin of the RP ID; Android's Credential Manager
// reports `android:apk-key-hash:<base64url SHA-256 of the signing certificate>`.
// The operating systems only allow this when the domain lists the app in
// /.well-known/apple-app-site-association and /.well-known/assetlinks.json.

function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** `TEAMID.bundle.id` values for the Apple app site association file. */
export function getMobileIosAppIds(): string[] {
  const teamId = process.env.MOBILE_IOS_TEAM_ID?.trim();
  const bundleId = process.env.MOBILE_IOS_BUNDLE_ID?.trim();
  return teamId && bundleId ? [`${teamId}.${bundleId}`] : [];
}

export function getMobileAndroidPackage(): string | null {
  return process.env.MOBILE_ANDROID_PACKAGE?.trim() || null;
}

/** Upper-case, colon-separated SHA-256 signing-certificate fingerprints. */
export function getMobileAndroidCertFingerprints(): string[] {
  return splitList(process.env.MOBILE_ANDROID_CERT_SHA256).flatMap((value) => {
    const hex = value.replace(/:/g, "").toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex)) return [];
    return [hex.match(/../g)!.join(":")];
  });
}

export function androidOriginForFingerprint(fingerprint: string): string {
  const bytes = Buffer.from(fingerprint.replace(/:/g, ""), "hex");
  return `android:apk-key-hash:${bytes.toString("base64url")}`;
}

/** Origins a native passkey ceremony may report: the web origin, the iOS app
 * (https origin of the RP ID) and each configured Android signing key. */
export function getMobilePasskeyOrigins(): string[] {
  const origins = new Set<string>([getPasskeyOrigin(), `https://${getPasskeyRpId()}`]);
  if (getMobileAndroidPackage()) {
    for (const fingerprint of getMobileAndroidCertFingerprints()) {
      origins.add(androidOriginForFingerprint(fingerprint));
    }
  }
  return [...origins];
}

/** Platform passkeys are always discoverable and must verify the user, since
 * on mobile the passkey takes the place of the password. */
export function mobileRegistrationOptionsForUser(
  user: { id: number; email: string; name: string },
  existing: Array<{ credentialId: string; transports: string[] | null }>,
) {
  return generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: getPasskeyRpId(),
    userName: user.email,
    userDisplayName: user.name,
    userID: new Uint8Array(Buffer.from(String(user.id))),
    attestationType: "none",
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: (credential.transports ?? []) as any,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
}

/** No allowCredentials: the phone offers whichever ComplyTrack passkeys it
 * holds, so the request reveals nothing about which accounts exist. */
export function mobileAuthenticationOptions() {
  return generateAuthenticationOptions({
    rpID: getPasskeyRpId(),
    userVerification: "required",
  });
}
