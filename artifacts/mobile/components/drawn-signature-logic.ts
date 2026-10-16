/**
 * A drawn signature as a PNG data URL, built from the strokes the user drew on
 * the phone. The API (track-actions resolverSignature) accepts only
 * `data:image/png;base64,...` up to 250,000 characters, the same as the
 * website's canvas signature. The phone has no canvas, so the strokes are
 * rasterised here into a two-colour indexed PNG (navy ink, transparent
 * background, like the website) with uncompressed deflate blocks: a 720×240
 * signature is about 30 KB of base64.
 *
 * Import-free so tests can load it directly with Node.
 */
export interface SignaturePoint { x: number; y: number }
export type SignatureStroke = SignaturePoint[];

/** Same drawing size as the website (components/drawn-signature-dialog.tsx). */
export const SIGNATURE_WIDTH = 720;
export const SIGNATURE_HEIGHT = 240;
/** The API's limit on resolverSignature. */
export const SIGNATURE_MAX_LENGTH = 250_000;
const INK = [0x16, 0x2d, 0x42];
const PEN_RADIUS = 2;

/** Whether the strokes amount to a signature (at least one drawn line). */
export function hasSignatureInk(strokes: readonly SignatureStroke[]): boolean {
  return strokes.some((stroke) => stroke.length > 1
    && stroke.some((point) => point.x !== stroke[0].x || point.y !== stroke[0].y));
}

/**
 * Rasterise strokes drawn on a box of `boxWidth`×`boxHeight` (view points)
 * into a 1-bit bitmap of `width`×`height`. Row-major, 1 = ink.
 */
export function rasteriseStrokes(
  strokes: readonly SignatureStroke[],
  boxWidth: number,
  boxHeight: number,
  width = SIGNATURE_WIDTH,
  height = SIGNATURE_HEIGHT,
): Uint8Array {
  const bitmap = new Uint8Array(width * height);
  if (!(boxWidth > 0) || !(boxHeight > 0)) return bitmap;
  const sx = width / boxWidth;
  const sy = height / boxHeight;
  const dot = (cx: number, cy: number) => {
    const x0 = Math.max(0, Math.floor(cx - PEN_RADIUS));
    const x1 = Math.min(width - 1, Math.ceil(cx + PEN_RADIUS));
    const y0 = Math.max(0, Math.floor(cy - PEN_RADIUS));
    const y1 = Math.min(height - 1, Math.ceil(cy + PEN_RADIUS));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= PEN_RADIUS ** 2) bitmap[y * width + x] = 1;
      }
    }
  };
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.length; i += 1) {
      const a = stroke[Math.max(0, i - 1)];
      const b = stroke[i];
      const ax = a.x * sx; const ay = a.y * sy;
      const bx = b.x * sx; const by = b.y * sy;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let s = 0; s <= steps; s += 1) dot(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
    }
  }
  return bitmap;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1; let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream with stored (uncompressed) deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  let o = 0;
  out[o++] = 0x78; out[o++] = 0x01;
  for (let b = 0; b < blocks; b += 1) {
    const start = b * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff; out[o++] = len >>> 8;
    out[o++] = ~len & 0xff; out[o++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  const adler = adler32(data);
  out[o++] = adler >>> 24; out[o++] = (adler >>> 16) & 0xff; out[o++] = (adler >>> 8) & 0xff; out[o++] = adler & 0xff;
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = len >>> 24; out[1] = (len >>> 16) & 0xff; out[2] = (len >>> 8) & 0xff; out[3] = len & 0xff;
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out, 4, 8 + len);
  out[8 + len] = crc >>> 24; out[9 + len] = (crc >>> 16) & 0xff; out[10 + len] = (crc >>> 8) & 0xff; out[11 + len] = crc & 0xff;
  return out;
}

/** A 1-bit indexed PNG: index 0 transparent, index 1 navy ink. */
export function encodeSignaturePng(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      if (bitmap[y * width + x]) raw[row + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const header = new Uint8Array(13);
  header[0] = width >>> 24; header[1] = (width >>> 16) & 0xff; header[2] = (width >>> 8) & 0xff; header[3] = width & 0xff;
  header[4] = height >>> 24; header[5] = (height >>> 16) & 0xff; header[6] = (height >>> 8) & 0xff; header[7] = height & 0xff;
  header[8] = 1; // bit depth
  header[9] = 3; // indexed colour
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', new Uint8Array([0xff, 0xff, 0xff, ...INK])),
    chunk('tRNS', new Uint8Array([0x00, 0xff])),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]; const b = bytes[i + 1]; const c = bytes[i + 2];
    out += BASE64[a >> 2]
      + BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (b === undefined ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)])
      + (c === undefined ? '=' : BASE64[c & 63]);
  }
  return out;
}

/** The strokes as the API's resolverSignature, or null when nothing is drawn. */
export function signatureDataUrl(
  strokes: readonly SignatureStroke[],
  boxWidth: number,
  boxHeight: number,
): string | null {
  if (!hasSignatureInk(strokes)) return null;
  const bitmap = rasteriseStrokes(strokes, boxWidth, boxHeight);
  const url = `data:image/png;base64,${toBase64(encodeSignaturePng(bitmap, SIGNATURE_WIDTH, SIGNATURE_HEIGHT))}`;
  return url.length <= SIGNATURE_MAX_LENGTH ? url : null;
}
