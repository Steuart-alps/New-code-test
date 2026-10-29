// Getting certificate files ready for ComplyTrack's AI to read, and for
// storage (components/certificate-reader-dialog.tsx). Several files can be
// read together (Steuart, 2026-10-29): the pages of one certificate
// photographed separately are joined into one PDF when it is saved.
import { heicToJpeg, isHeic } from "@/lib/media-upload";

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Most files read together, and most bytes sent in one go (the server's limits too). */
export const MAX_READ_FILES = 10;
export const MAX_READ_BYTES = 20 * 1024 * 1024;
/** Largest photo Claude reads; photos are shrunk well below this first. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** What the file picker offers. HEIC and TIFF photos are turned into JPEG where the browser can open them. */
export const CERTIFICATE_INPUT_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.tif,.tiff,.docx,application/pdf,image/*";

const READABLE = /^(application\/pdf|image\/(jpeg|png|webp|gif)|text\/plain)$/;
const TIFF = /\.(tif|tiff)$/i;

/** A chosen file, ready to read and to store. */
export interface CertificateFile {
  name: string;
  /** What is sent to the AI and joined into a PDF: photos shrunk and HEIC/TIFF turned into JPEG. */
  blob: Blob;
  mimeType: string;
  /** What is stored when the certificate is on this file alone: the original, unless it had to be converted. */
  stored: File;
}

export function fileMimeType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext === "pdf" ? "application/pdf" : ext === "docx" ? DOCX_TYPE
    : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "heic" || ext === "heif" ? "image/heic"
    : ext === "tif" || ext === "tiff" ? "image/tiff" : ext === "doc" ? "application/msword" : "";
}

/** A photo the browser can open (TIFF in Safari, for example) as a JPEG, or null when it cannot. */
async function imageToJpeg(file: Blob, maxSide = 4096): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Phone photos are shrunk to 2,000 pixels before they are read; Claude reads them just as well. */
async function shrinkPhoto(file: Blob, mimeType: string): Promise<{ blob: Blob; mimeType: string }> {
  if (!/^image\/(jpeg|png|webp)$/.test(mimeType) || typeof createImageBitmap !== "function") return { blob: file, mimeType };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1_500_000) { bitmap.close(); return { blob: file, mimeType }; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ? { blob, mimeType: "image/jpeg" } : { blob: file, mimeType };
  } catch {
    return { blob: file, mimeType };
  }
}

const megabytes = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MB`;

/**
 * Get the chosen files ready. Files that cannot be read are left out, each
 * with a plain reason naming it, so the rest can still go ahead.
 */
export async function prepareCertificateFiles(chosen: File[]): Promise<{ ready: CertificateFile[]; problems: string[] }> {
  const problems: string[] = [];
  const files = chosen.slice(0, MAX_READ_FILES);
  if (chosen.length > MAX_READ_FILES) {
    problems.push(`ComplyTrack reads up to ${MAX_READ_FILES} files at a time, so the last ${chosen.length - MAX_READ_FILES} were left out. Add them in another batch.`);
  }
  const ready: CertificateFile[] = [];
  let total = 0;
  for (const original of files) {
    let file = original;
    let mimeType = fileMimeType(file);
    if (isHeic(file)) {
      file = await heicToJpeg(file);
      if (isHeic(file)) {
        problems.push(`${original.name}: this iPhone photo (HEIC) can't be opened in this browser. Open ComplyTrack in Safari, or save the photo as a JPEG, and add it again.`);
        continue;
      }
      mimeType = "image/jpeg";
    } else if (mimeType === "image/tiff" || TIFF.test(file.name)) {
      const jpeg = await imageToJpeg(file);
      if (!jpeg) {
        problems.push(`${original.name}: this scan (TIFF) can't be opened in this browser. Save it as a PDF or JPEG and add it again.`);
        continue;
      }
      file = new File([jpeg], file.name.replace(TIFF, ".jpg"), { type: "image/jpeg", lastModified: file.lastModified });
      mimeType = "image/jpeg";
    }
    if (mimeType === "application/msword") {
      problems.push(`${original.name}: this is an older Word file (.doc). Save it as a PDF and add it again.`);
      continue;
    }
    if (!READABLE.test(mimeType) && mimeType !== DOCX_TYPE) {
      problems.push(`${original.name}: ComplyTrack can read PDFs, photos and Word (.docx) files. Save it as a PDF and add it again.`);
      continue;
    }
    const shrunk = await shrinkPhoto(file, mimeType);
    if (shrunk.mimeType.startsWith("image/") && shrunk.blob.size > MAX_PHOTO_BYTES) {
      problems.push(`${original.name}: this photo is too large to read (5 MB at most). Take it again at a lower size, or save it as a PDF.`);
      continue;
    }
    if (shrunk.blob.size > MAX_READ_BYTES) {
      problems.push(`${original.name}: this file is ${megabytes(shrunk.blob.size)}, and ComplyTrack reads up to 20 MB at a time. Scan it at a lower resolution, or split it into smaller PDFs.`);
      continue;
    }
    if (total + shrunk.blob.size > MAX_READ_BYTES) {
      problems.push(`${original.name}: the files chosen come to more than 20 MB together, so this one was left out. Add it in another batch.`);
      continue;
    }
    total += shrunk.blob.size;
    ready.push({ name: original.name, blob: shrunk.blob, mimeType: shrunk.mimeType, stored: file });
  }
  return { ready, problems };
}

export function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.readAsDataURL(blob);
  });
}

/** A4 in PDF points, for photos joined into a PDF. */
const A4 = { short: 595, long: 842 };

/**
 * One file to store for a certificate: the file itself when it is on one
 * file, otherwise its PDFs and photos joined into one PDF, in order.
 */
export async function certificateFileFor(parts: CertificateFile[], name: string): Promise<File> {
  if (parts.length === 1) return parts[0]!.stored;
  const { PDFDocument } = await import("pdf-lib");
  const joined = await PDFDocument.create();
  for (const part of parts) {
    if (part.mimeType === "application/pdf") {
      let source: Awaited<ReturnType<typeof PDFDocument.load>>;
      try {
        source = await PDFDocument.load(await part.blob.arrayBuffer(), { ignoreEncryption: true });
      } catch {
        throw new Error(`${part.name} could not be joined with the other pages (it may be password-protected). Save the pages as one PDF and read that instead.`);
      }
      for (const page of await joined.copyPages(source, source.getPageIndices())) joined.addPage(page);
      continue;
    }
    if (!part.mimeType.startsWith("image/")) {
      throw new Error(`${part.name} is a Word or text file, which can't be joined with other pages. Save it as a PDF and read it again.`);
    }
    let bytes = await part.blob.arrayBuffer();
    let png = part.mimeType === "image/png";
    if (part.mimeType !== "image/jpeg" && !png) {
      const jpeg = await imageToJpeg(part.blob);
      if (!jpeg) throw new Error(`${part.name} could not be joined with the other pages. Save it as a JPEG and read it again.`);
      bytes = await jpeg.arrayBuffer();
      png = false;
    }
    const image = png ? await joined.embedPng(bytes) : await joined.embedJpg(bytes);
    const landscape = image.width > image.height;
    const fit = image.scaleToFit(landscape ? A4.long : A4.short, landscape ? A4.short : A4.long);
    const page = joined.addPage([fit.width, fit.height]);
    page.drawImage(image, { x: 0, y: 0, width: fit.width, height: fit.height });
  }
  const pdf = await joined.save();
  const safeName = name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Certificate";
  return new File([pdf.slice().buffer as ArrayBuffer], `${safeName}.pdf`, { type: "application/pdf" });
}
