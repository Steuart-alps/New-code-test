import crypto from "crypto";

/** Digest high-entropy bearer credentials before they cross the database boundary. */
export function digestBearerToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newBearerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Encrypt raw credentials only for the short-lived dispatch boundary. */
export function encryptTokenPayload(payload: Record<string, string>): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required to encrypt queued bearer tokens");
  const key = crypto.createHash("sha256").update(secret, "utf8").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptTokenPayload(encoded: string): Record<string, string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required to decrypt queued bearer tokens");
  const [ivText, tagText, ciphertextText] = encoded.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted queued token payload");
  const key = crypto.createHash("sha256").update(secret, "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const clear = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]);
  const value = JSON.parse(clear.toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid queued token payload");
  return value as Record<string, string>;
}