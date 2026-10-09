import sharp from "sharp";
import { Worker } from "node:worker_threads";

export class ObjectContentError extends Error {
  constructor(message = "Uploaded file contents are not an allowed document type") {
    super(message);
    this.name = "ObjectContentError";
    Object.setPrototypeOf(this, ObjectContentError.prototype);
  }
}

export const MAX_RESTRICTED_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 12_000;

export type AllowedUploadType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "image/avif";
export type AllowedIssueMediaType = AllowedUploadType | "video/mp4" | "video/quicktime" | "video/webm";
export type AllowedIssueVideoType = Extract<AllowedIssueMediaType, `video/${string}`>;

/** Magic-byte/format checks intentionally do not trust filename or MIME. */
export function detectUploadType(bytes: Buffer): AllowedUploadType | null {
  // PDF requires a conforming header. %%EOF cannot reliably be in a bounded
  // prefix, but this rejects arbitrary bytes merely prefixed with "%PDF-".
  if (bytes.length >= 9 && /^%PDF-[12]\.\d(?:\r?\n|[\x20\t])/.test(bytes.subarray(0, 10).toString("ascii"))) return "application/pdf";
  // JPEG: SOI, a legal non-standalone marker, and a complete first marker
  // segment contained in our bounded read. This is enough structural evidence
  // to reject MIME-spoofed arbitrary byte streams without loading the file.
  if (bytes.length >= 8 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const marker = bytes[3];
    const segmentLength = bytes.readUInt16BE(4);
    if (marker >= 0xc0 && marker <= 0xfe && marker !== 0xd8 && marker !== 0xd9 && marker !== 0xff
      && segmentLength >= 2 && segmentLength + 4 <= bytes.length) return "image/jpeg";
  }
  // PNG signature plus mandatory first IHDR chunk (length=13, type=IHDR).
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 24 && png.every((byte, index) => bytes[index] === byte)
    && bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).toString("ascii") === "IHDR"
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return "image/png";
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 16
    && bytes.readUInt32BE(0) >= 16
    && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = [bytes.subarray(8, 12).toString("ascii")];
    const scanEnd = Math.min(bytes.length, 256);
    for (let offset = 16; offset + 4 <= scanEnd; offset += 4) {
      brands.push(bytes.subarray(offset, offset + 4).toString("ascii"));
    }
    if (brands.some((brand) => [
      "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs",
    ].includes(brand))) return "image/heic";
    if (brands.some((brand) => ["avif", "avis"].includes(brand))) return "image/avif";
    if (brands.some((brand) => ["mif1", "msf1"].includes(brand))) return "image/heif";
  }
  return null;
}

/** Classify supported video containers from their headers, not their names. */
export function detectIssueVideoType(bytes: Buffer): AllowedIssueVideoType | null {
  if (bytes.length >= 16
    && bytes.readUInt32BE(0) >= 16
    && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = [bytes.subarray(8, 12).toString("ascii")];
    const scanEnd = Math.min(bytes.length, 256);
    for (let offset = 16; offset + 4 <= scanEnd; offset += 4) {
      brands.push(bytes.subarray(offset, offset + 4).toString("ascii"));
    }
    if (brands.includes("qt  ")) return "video/quicktime";
    if (brands.some((brand) => [
      "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "mp41", "mp42",
      "mp21", "avc1", "M4V ", "dash",
    ].includes(brand))) {
      return "video/mp4";
    }
  }
  if (bytes.length >= 4
    && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const headerEnd = Math.min(bytes.length, 128);
    for (let offset = 4; offset + 7 <= headerEnd; offset++) {
      if (bytes[offset] === 0x42
        && bytes[offset + 1] === 0x82
        && bytes[offset + 2] === 0x84
        && bytes.subarray(offset + 3, offset + 7).toString("ascii") === "webm") {
        return "video/webm";
      }
    }
  }
  return null;
}

export async function validateUploadContent(
  bytes: Buffer,
  allowed: ReadonlySet<AllowedUploadType>,
): Promise<{ contentType: AllowedUploadType; sourceContentType: AllowedUploadType; normalizedBytes?: Buffer }> {
  if (bytes.length <= 0 || bytes.length > MAX_RESTRICTED_UPLOAD_BYTES) throw new ObjectContentError("File size is not allowed");
  const type = detectUploadType(bytes);
  if (!type || !allowed.has(type)) throw new ObjectContentError();
  try {
    if (type === "application/pdf") {
      await validatePdf(bytes);
      return { contentType: type, sourceContentType: type };
    }
    if (type === "image/png") validatePngChunkChecksums(bytes);
    const image = sharp(bytes, {
      // libvips reports checksum/decompression damage as warnings for some PNG
      // chunks. Treat warnings as fatal so a successful re-encode cannot mask
      // corruption in attacker-supplied input.
      failOn: "warning",
      limitInputPixels: MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION,
      pages: 1,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const isHeifInput = type === "image/heic" || type === "image/heif" || type === "image/avif";
    const expectedFormat = isHeifInput
      ? "heif"
      : type === "image/jpeg" ? "jpeg" : type === "image/png" ? "png" : "webp";
    if (metadata.format !== expectedFormat
      || metadata.pages && metadata.pages !== 1
      || !metadata.width || !metadata.height
      || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) {
      throw new ObjectContentError("Image format, dimensions, or frame count is invalid");
    }
    // Full decode is forced by re-encoding, unlike metadata-only inspection.
    const contentType: AllowedUploadType = isHeifInput ? "image/jpeg" : type;
    const normalizedBytes = contentType === "image/jpeg"
      ? await image.rotate().jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer()
      : contentType === "image/png"
        ? await image.rotate().png({ compressionLevel: 9 }).toBuffer()
        : await image.rotate().webp({ quality: 90 }).toBuffer();
    if (normalizedBytes.length > MAX_RESTRICTED_UPLOAD_BYTES) throw new ObjectContentError("Normalized image is too large");
    return { contentType, sourceContentType: type, normalizedBytes };
  } catch (error) {
    if (error instanceof ObjectContentError) throw error;
    throw new ObjectContentError(type === "application/pdf" ? "PDF structure is invalid" : "Image data is invalid");
  }
}

function validatePngChunkChecksums(bytes: Buffer): void {
  let offset = 8;
  let chunkIndex = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) throw new ObjectContentError("PNG chunk is truncated");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      throw new ObjectContentError("PNG header is invalid");
    }
    const expected = bytes.readUInt32BE(offset + 8 + length);
    const actual = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (actual !== expected) throw new ObjectContentError("PNG checksum is invalid");
    offset = chunkEnd;
    chunkIndex++;
    if (type === "IEND") {
      if (length !== 0) throw new ObjectContentError("PNG end chunk is invalid");
      return; // Deliberately allow trailing data; normalized output strips it.
    }
  }
  throw new ObjectContentError("PNG end chunk is missing");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function validatePdf(bytes: Buffer) {
  await validatePdfInWorker(bytes);
}

export async function validatePdfInWorker(
  bytes: Buffer,
  options: { timeoutMs?: number; testMode?: "timeout" | "oom" } = {},
): Promise<void> {
  const timeoutMs = Math.max(50, Math.min(options.timeoutMs ?? 4_000, 10_000));
  const workerUrl = new URL("./pdf-validation-worker.mjs", import.meta.url);
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { bytes: new Uint8Array(bytes), testMode: options.testMode },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 2,
      },
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(new ObjectContentError(error.message)) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("PDF validation timed out")), timeoutMs);
    worker.once("message", (message: { ok?: boolean; error?: string }) =>
      message.ok ? finish() : finish(new Error(message.error || "PDF validation failed")));
    worker.once("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      finish(new Error(`PDF validation worker failed: ${message}`));
    });
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`PDF validation worker exited unexpectedly (${code})`));
    });
  });
}