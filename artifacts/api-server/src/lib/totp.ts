/**
 * Minimal TOTP (RFC 6238) implementation using Node.js built-in crypto.
 * No external dependencies — avoids esbuild ESM/CJS interop issues with otplib.
 */
import { createHmac, randomBytes } from "crypto";

// Base32 alphabet (RFC 4648)
const B32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode a Buffer to base32 (no padding) */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_CHARS[(value << (5 - bits)) & 31];
  return out;
}

/** Decode a base32 string to Buffer */
function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = B32_CHARS.indexOf(ch);
    if (idx === -1) continue; // skip non-base32 chars (spaces, dashes)
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generate a random base32 secret (20 bytes → 32-char secret) */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Compute a TOTP code for a given secret and time step (default 30 s) */
export function generateToken(secret: string, time = Date.now()): string {
  const counter = Math.floor(time / 1000 / 30);
  const buf = Buffer.alloc(8);
  // Write 64-bit big-endian counter
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const key = base32Decode(secret);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, "0");
}

/** Verify a TOTP token, allowing ±1 time step to handle clock drift */
export function verifyToken(token: string, secret: string): boolean {
  const now = Date.now();
  for (const drift of [-1, 0, 1]) {
    if (generateToken(secret, now + drift * 30_000) === token.trim()) return true;
  }
  return false;
}

/** Build an otpauth:// URI for QR code generation */
export function keyUri(email: string, issuer: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
