// Photos and videos uploaded straight to storage (FixTrack issues and track
// actions): the accepted types, the private URL to show them, and a PUT that
// reports progress.

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");
// HEIC/HEIF is left out on purpose: the server cannot decode iPhone HEIC
// (HEVC) photos, and because the picker does not list HEIC, iPhones hand
// over their photos as JPEG.
export const MEDIA_INPUT_ACCEPT = "image/jpeg,image/png,image/webp,image/avif,video/mp4,video/quicktime,video/webm";
export const HEIC_EXTENSION = /\.(heic|heif)$/i;
export const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function mediaContentType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_TYPE_BY_EXTENSION[extension] ?? "";
}

// Media elements cannot send the active-client query that clientApiFetch adds,
// so a consultant's tenant goes in the URL, as check-photo-uploader does.
export function privateObjectUrl(objectPath: string, clientId: number | null | undefined): string {
  const normalizedPath = objectPath.startsWith("/objects/")
    ? objectPath
    : `/objects/${objectPath.replace(/^\/+/, "")}`;
  return `${API_BASE}/storage${normalizedPath}${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`;
}

export function putFileWithProgress(
  uploadUrl: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl);
    request.setRequestHeader("Content-Type", contentType);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Storage upload failed (${request.status}).`));
    });
    request.addEventListener("error", () => reject(new Error("Network error while uploading the file.")));
    request.addEventListener("abort", () => reject(new Error("Upload was cancelled.")));
    request.send(file);
  });
}

export const VIDEO_PATH = /\.(mp4|mov|webm|avi|m4v|3gp|ogv|mkv|mpeg|mpg|ts)$/i;

/** Why a picked or dropped file can't be used as a photo or video, or null when it can. */
export function mediaFileProblem(file: File): string | null {
  const contentType = mediaContentType(file);
  if (/^image\/hei[cf]/.test(contentType) || HEIC_EXTENSION.test(file.name)) {
    return "HEIC photos can't be read. Save the photo as JPEG and upload it again.";
  }
  if (!Object.values(MEDIA_TYPE_BY_EXTENSION).includes(contentType)) return "Use a JPEG, PNG, WebP, MP4, MOV, or WebM file.";
  if (contentType.startsWith("image/") && file.size > 10 * 1024 * 1024) return "Photos must be 10 MB or smaller.";
  return null;
}
