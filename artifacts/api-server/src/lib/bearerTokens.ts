import crypto from "crypto";

const ENVELOPE_VERSION = "v2";

/** Digest high-entropy bearer credentials before they cross the database boundary. */
export function digestBearerToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newBearerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function keyFromSecret(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function currentEncryptionKey(): { version: string; secret: string } {
  const dedicated = process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY;
  if (dedicated) {
    const version = process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION;
    if (!version) {
      throw new Error("CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION is required with CONTRACTOR_TOKEN_ENCRYPTION_KEY");
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(version)) {
      throw new Error("CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION must be 1-32 URL-safe characters");
    }
    return { version, secret: dedicated };
  }
  const legacy = process.env.SESSION_SECRET;
  if (!legacy) throw new Error(
    "CONTRACTOR_TOKEN_ENCRYPTION_KEY or SESSION_SECRET is required to encrypt queued bearer tokens",
  );
  return { version: "session-v1", secret: legacy };
}

function previousEncryptionKeys(): Record<string, string> {
  const encoded = process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS;
  if (!encoded) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS must be a JSON object");
  }
  const keys: Record<string, string> = Object.create(null);
  for (const [version, secret] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(version) || typeof secret !== "string" || secret.length < 32) {
      throw new Error("Every previous contractor token encryption key needs a URL-safe version and at least 32 characters");
    }
    keys[version] = secret;
  }
  return keys;
}

export function validateTokenEncryptionConfig(): void {
  const current = currentEncryptionKey();
  if (current.secret.length < 32) {
    throw new Error("The contractor token encryption key must be at least 32 characters");
  }
  const previous = previousEncryptionKeys();
  if (Object.keys(previous).length > 5) {
    throw new Error("At most five previous contractor token encryption keys may be retained");
  }
  if (Object.prototype.hasOwnProperty.call(previous, current.version)) {
    throw new Error("The current contractor token encryption key version must not also appear in previous keys");
  }
}

function decryptWithSecret(
  ivText: string,
  tagText: string,
  ciphertextText: string,
  secret: string,
  aad?: string,
): Record<string, string> {
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(ivText, "base64url"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const clear = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]);
  const value = JSON.parse(clear.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid queued token payload");
  }
  return value as Record<string, string>;
}

/** Encrypt raw credentials only for the short-lived dispatch boundary. */
export function encryptTokenPayload(payload: Record<string, string>): string {
  const { version, secret } = currentEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  cipher.setAAD(Buffer.from(`${ENVELOPE_VERSION}.${version}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [
    ENVELOPE_VERSION,
    version,
    ...[iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")),
  ].join(".");
}

export function decryptTokenPayload(encoded: string): Record<string, string> {
  const parts = encoded.split(".");
  if (parts[0] === "v1" || parts[0] === ENVELOPE_VERSION) {
    const [, version, ivText, tagText, ciphertextText] = parts;
    if (!version || !ivText || !tagText || !ciphertextText || parts.length !== 5) {
      throw new Error("Invalid encrypted queued token payload");
    }
    const current = currentEncryptionKey();
    const secret = version === current.version
      ? current.secret
      : previousEncryptionKeys()[version]
        ?? (version === "session-v1" ? process.env.SESSION_SECRET : undefined);
    if (!secret) throw new Error(`No contractor token encryption key is available for version ${version}`);
    const aad = parts[0] === ENVELOPE_VERSION ? `${ENVELOPE_VERSION}.${version}` : undefined;
    return decryptWithSecret(ivText, tagText, ciphertextText, secret, aad);
  }

  // Legacy three-part payloads were encrypted directly with SESSION_SECRET.
  const [ivText, tagText, ciphertextText] = parts;
  if (!ivText || !tagText || !ciphertextText || parts.length !== 3) {
    throw new Error("Invalid encrypted queued token payload");
  }
  const candidates = [
    process.env.SESSION_SECRET,
    process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY,
    ...Object.values(previousEncryptionKeys()),
  ].filter((value): value is string => Boolean(value));
  for (const secret of new Set(candidates)) {
    try {
      return decryptWithSecret(ivText, tagText, ciphertextText, secret);
    } catch {
      // Try the next explicitly configured legacy key.
    }
  }
  throw new Error("No configured key can decrypt the legacy queued token payload");
}

export function tokenPayloadNeedsReencryption(encoded: string): boolean {
  const [envelope, version] = encoded.split(".");
  if (envelope !== ENVELOPE_VERSION || !version) return true;
  return version !== currentEncryptionKey().version;
}