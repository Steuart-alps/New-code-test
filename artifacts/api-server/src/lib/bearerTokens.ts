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

/**
 * Why a queued credential envelope could not be opened. Messages never
 * include ciphertext, key material or decrypted content.
 * - malformed:      not a well-formed envelope (bad parts, encoding or sizes)
 * - unknown_key:    the envelope names a key version this server does not hold
 *                   (a configuration problem, e.g. a retired key removed early)
 * - integrity:      authentication failed: the envelope was altered, relabelled
 *                   or downgraded, or encrypted with a different key
 * - payload_shape:  it decrypted, but the content is not a credential payload
 */
export type TokenPayloadFailure = "malformed" | "unknown_key" | "integrity" | "payload_shape";

export class TokenPayloadError extends Error {
  constructor(public readonly reason: TokenPayloadFailure, message: string) {
    super(message);
    this.name = "TokenPayloadError";
  }
}

/** A draft whose credentials cannot be trusted; it must never be dispatched. */
export function isDamagedTokenPayload(err: unknown): err is TokenPayloadError {
  return err instanceof TokenPayloadError && err.reason !== "unknown_key";
}

export type QueuedTokenPayload = Partial<Record<"booked" | "completed" | "quote" | "portal", string>>;

const BEARER_TOKEN = /^[A-Za-z0-9-]{32,128}$/;
const PORTAL_URL = /^https?:\/\/[^\s"'<>$`\\]{1,2000}\/contractor-portal\/[A-Za-z0-9-]{32,128}$/;
// Portal values are full links; drafts scrubbed by the legacy migration may
// hold just the token.
const PORTAL_VALUE = new RegExp(`(?:${PORTAL_URL.source})|(?:${BEARER_TOKEN.source})`);
const PAYLOAD_FIELDS: Record<keyof QueuedTokenPayload, RegExp> = {
  booked: BEARER_TOKEN,
  completed: BEARER_TOKEN,
  quote: BEARER_TOKEN,
  portal: PORTAL_VALUE,
};

/** Accept only the credential fields the queue uses, each in its exact form. */
export function validateTokenPayload(value: unknown): QueuedTokenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TokenPayloadError("payload_shape", "Queued token payload must be a plain object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new TokenPayloadError("payload_shape", "Queued token payload is empty");
  const payload: QueuedTokenPayload = {};
  for (const [field, raw] of entries) {
    const pattern = PAYLOAD_FIELDS[field as keyof QueuedTokenPayload];
    if (!pattern || !Object.prototype.hasOwnProperty.call(PAYLOAD_FIELDS, field)) {
      throw new TokenPayloadError("payload_shape", "Queued token payload has an unexpected field");
    }
    if (typeof raw !== "string" || !pattern.test(raw)) {
      throw new TokenPayloadError("payload_shape", `Queued token payload field '${field}' is not a valid credential`);
    }
    payload[field as keyof QueuedTokenPayload] = raw;
  }
  return payload;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodePart(text: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(text)) throw new TokenPayloadError("malformed", "Invalid encrypted queued token payload");
  const bytes = Buffer.from(text, "base64url");
  // Reject non-canonical encodings so an envelope has exactly one spelling.
  if (bytes.toString("base64url") !== text) throw new TokenPayloadError("malformed", "Invalid encrypted queued token payload");
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new TokenPayloadError("malformed", "Invalid encrypted queued token payload");
  }
  if (bytes.length === 0) throw new TokenPayloadError("malformed", "Invalid encrypted queued token payload");
  return bytes;
}

function decryptWithSecret(
  ivText: string,
  tagText: string,
  ciphertextText: string,
  secret: string,
  aad?: string,
): QueuedTokenPayload {
  const iv = decodePart(ivText, IV_BYTES);
  const tag = decodePart(tagText, TAG_BYTES);
  const ciphertext = decodePart(ciphertextText);
  let clear: Buffer;
  try {
    // A fixed tag length stops a truncated tag from weakening authentication.
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromSecret(secret), iv, { authTagLength: TAG_BYTES });
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new TokenPayloadError("integrity", "Queued token payload failed authentication");
  }
  let value: unknown;
  try {
    value = JSON.parse(clear.toString("utf8"));
  } catch {
    // The parser's message would quote decrypted text; never surface it.
    throw new TokenPayloadError("payload_shape", "Queued token payload is not valid JSON");
  }
  return validateTokenPayload(value);
}

/** Encrypt raw credentials only for the short-lived dispatch boundary. */
export function encryptTokenPayload(payload: Record<string, string>): string {
  const valid = validateTokenPayload(payload);
  const { version, secret } = currentEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromSecret(secret), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`${ENVELOPE_VERSION}.${version}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(valid), "utf8"), cipher.final()]);
  return [
    ENVELOPE_VERSION,
    version,
    ...[iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")),
  ].join(".");
}

const KEY_VERSION = /^[A-Za-z0-9_-]{1,32}$/;

export function decryptTokenPayload(encoded: string): QueuedTokenPayload {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 16_384) {
    throw new TokenPayloadError("malformed", "Invalid encrypted queued token payload");
  }
  const parts = encoded.split(".");
  if (parts[0] === "v1" || parts[0] === ENVELOPE_VERSION) {
    const [, version, ivText, tagText, ciphertextText] = parts;
    if (parts.length !== 5 || !version || !KEY_VERSION.test(version) || !ivText || !tagText || !ciphertextText) {
      throw new TokenPayloadError("malformed", "Invalid encrypted queued token payload");
    }
    const current = currentEncryptionKey();
    const secret = version === current.version
      ? current.secret
      : previousEncryptionKeys()[version]
        ?? (version === "session-v1" ? process.env.SESSION_SECRET : undefined);
    if (!secret) {
      throw new TokenPayloadError("unknown_key", `No contractor token encryption key is available for version ${version}`);
    }
    // v2 binds the envelope and key labels as associated data, so relabelling
    // a v2 envelope (including as v1, which has none) fails authentication.
    const aad = parts[0] === ENVELOPE_VERSION ? `${ENVELOPE_VERSION}.${version}` : undefined;
    return decryptWithSecret(ivText, tagText, ciphertextText, secret, aad);
  }

  // Legacy three-part payloads were encrypted directly with SESSION_SECRET.
  const [ivText, tagText, ciphertextText] = parts;
  if (parts.length !== 3 || !ivText || !tagText || !ciphertextText) {
    throw new TokenPayloadError("malformed", "Invalid encrypted queued token payload");
  }
  const candidates = [
    process.env.SESSION_SECRET,
    process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY,
    ...Object.values(previousEncryptionKeys()),
  ].filter((value): value is string => Boolean(value));
  let lastError: TokenPayloadError | null = null;
  for (const secret of new Set(candidates)) {
    try {
      return decryptWithSecret(ivText, tagText, ciphertextText, secret);
    } catch (err) {
      if (!(err instanceof TokenPayloadError) || err.reason === "malformed") throw err;
      // A wrong key fails authentication; try the next configured key. A key
      // that authenticates but yields a bad payload is reported as such.
      if (err.reason === "payload_shape") lastError = err;
    }
  }
  throw lastError ?? new TokenPayloadError("integrity", "No configured key can decrypt the legacy queued token payload");
}

export function tokenPayloadNeedsReencryption(encoded: string): boolean {
  const [envelope, version] = encoded.split(".");
  if (envelope !== ENVELOPE_VERSION || !version) return true;
  return version !== currentEncryptionKey().version;
}