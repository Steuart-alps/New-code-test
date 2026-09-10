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
    attestationType: "none",
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: (credential.transports ?? []) as any,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  };
  return generateRegistrationOptions(options);
}

export function authenticationOptionsForUser(
  credentials: Array<{ credentialId: string; transports: string[] | null }>,
) {
  const options = {
    rpID: getPasskeyRpId(),
    userVerification: "preferred",
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: (credential.transports ?? []) as any,
    })),
  };
  return generateAuthenticationOptions(options);
}