/**
 * Largest single file the API stores (MAX_UPLOAD_MB on the server, default
 * 250 MB), videos included. Checked here so nobody waits for a large upload
 * that would be refused; the server enforces the real limit either way.
 */
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export function assertWithinUploadLimit(file: File): void {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`"${file.name}" is larger than 250 MB. Trim or compress it (for a video, record a shorter clip or at a lower resolution) and try again.`);
  }
}
