/**
 * CheckPhotoUploader — reusable photo and video attachment component for any
 * check record.
 *
 * Usage:
 *   <CheckPhotoUploader entityType="fire_safety_check" entityId={check.id} />
 *
 * The component lists existing photos, handles presigned-URL uploads, and
 * lets users delete photos. If `required` is true a badge is shown but no
 * enforcement is done here — the parent form decides whether to block submit.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { Camera, ImagePlus, Trash2, X, ZoomIn, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useAuth } from "@/context/auth-context";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useCameraCapture } from "@/components/camera-capture";
import { MEDIA_INPUT_ACCEPT, VIDEO_PATH, mediaContentType, mediaFileProblem } from "@/lib/media-upload";
import { assertWithinUploadLimit } from "@/lib/upload-limits";

// ── API helpers ───────────────────────────────────────────────────────────────

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");

async function parsePhotoResponse<T = any>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

// The same record's photos can show in two places at once (its row in a list
// and its edit form), so a change in one refreshes the other.
const PHOTOS_CHANGED = "check-photos-changed";
type PhotosChanged = { key: string; from?: object };
export function announcePhotosChanged(entityType: string, entityId: number, from?: object) {
  window.dispatchEvent(new CustomEvent<PhotosChanged>(PHOTOS_CHANGED, { detail: { key: `${entityType}:${entityId}`, from } }));
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckPhoto {
  id: number;
  entityType: string;
  entityId: number;
  objectPath: string;
  caption?: string | null;
  createdAt: string;
}

export interface CheckPhotoUploaderProps {
  entityType: string;
  entityId: number;
  required?: boolean;
  /** Configured minimum when photos are required. */
  minPhotos?: number;
  /** When true, renders in a compact inline strip rather than a full grid. */
  compact?: boolean;
  /** Preserve photo viewing while suppressing upload and deletion controls. */
  readOnly?: boolean;
  /** Called whenever the photo count changes (useful for form validation). */
  onCountChange?: (count: number) => void;
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

/**
 * Modal photo viewer. Focus moves to the close button when it opens and stays
 * inside it (the close button is its only control) until Escape, the close
 * button or a backdrop click closes it; the opener restores focus.
 */
function Lightbox({ src, label, video, onClose }: { src: string; label: string; video: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // A video's own controls take focus too; anything else returns to close.
      else if (e.key === "Tab" && !video) { e.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, video]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        aria-label="Close photo"
        className="absolute top-4 right-4 rounded text-white/70 hover:text-white focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white transition-colors"
        onClick={onClose}
      >
        <X className="w-6 h-6" aria-hidden="true" />
      </button>
      {video ? (
        <video
          src={src}
          aria-label={label}
          controls
          autoPlay
          playsInline
          className="max-w-[90vw] max-h-[90vh] rounded shadow-2xl"
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <img
          src={src}
          alt={label}
          className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-2xl"
          onClick={e => e.stopPropagation()}
        />
      )}
    </div>
  );
}

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

// ── Main component ────────────────────────────────────────────────────────────

export function CheckPhotoUploader({
  entityType,
  entityId,
  required = false,
  minPhotos = 1,
  compact = false,
  readOnly = false,
  onCountChange,
}: CheckPhotoUploaderProps) {
  const { activeClientId } = useAuth();
  const request = useActiveClientApi();
  const apiFetch = useCallback(async <T = any,>(path: string, init?: RequestInit): Promise<T> => {
    return parsePhotoResponse<T>(await request(path, init));
  }, [request]);
  const [photos, setPhotos] = useState<CheckPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; label: string; video: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // The control that opened the lightbox, so focus returns to it on close.
  const lightboxOpenerRef = useRef<HTMLElement | null>(null);
  const { toast } = useToast();
  // Identifies this box's own change announcements.
  const self = useRef({});

  // ── Fetch existing photos ─────────────────────────────────────────────────

  const fetchPhotos = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await apiFetch<any[]>(`/photos?entityType=${encodeURIComponent(entityType)}&entityId=${entityId}`);
      // API returns snake_case; normalise to camelCase for the component
      const normalised: CheckPhoto[] = data.map(p => ({
        id: p.id,
        entityType: p.entity_type,
        entityId: p.entity_id,
        objectPath: p.object_path,
        caption: p.caption,
        createdAt: p.created_at,
      }));
      setPhotos(normalised);
      onCountChange?.(normalised.length);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, onCountChange, apiFetch]);

  useEffect(() => { fetchPhotos(); }, [fetchPhotos]);
  useEffect(() => {
    const changed = (event: Event) => {
      const { key, from } = (event as CustomEvent<PhotosChanged>).detail;
      if (key === `${entityType}:${entityId}` && from !== self.current) void fetchPhotos();
    };
    window.addEventListener(PHOTOS_CHANGED, changed);
    return () => window.removeEventListener(PHOTOS_CHANGED, changed);
  }, [entityType, entityId, fetchPhotos]);

  // ── Upload flow ───────────────────────────────────────────────────────────

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset input so same file can be re-selected
    e.target.value = "";
    void uploadFiles(files);
  };

  // Picked, photographed or dropped photos, one after another.
  const uploadFiles = async (files: File[]) => {
    if (readOnly || uploading || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) await uploadFile(file);
    } finally {
      setUploading(false);
    }
  };

  const uploadFile = async (file: File) => {
    const problem = mediaFileProblem(file);
    if (problem) {
      toast({ title: `${file.name} can't be added`, description: problem, variant: "destructive" });
      return;
    }
    const contentType = mediaContentType(file);

    try {
      assertWithinUploadLimit(file);
      // Step 1 — request presigned URL
      const { uploadUrl, objectPath } = await apiFetch<{ uploadUrl: string; objectPath: string }>(
        "/photos/request-upload",
        {
          method: "POST",
          body: JSON.stringify({ entityType, entityId, name: file.name.slice(0, 200), contentType }),
        }
      );

      // Step 2 — PUT file directly to GCS
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload to storage failed");

      // Step 3 — record in database
      await apiFetch("/photos", {
        method: "POST",
        body: JSON.stringify({ entityType, entityId, objectPath }),
      });

      await fetchPhotos();
      announcePhotosChanged(entityType, entityId, self.current);
      toast({ title: contentType.startsWith("video/") ? "Video added" : "Photo added" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    }
  };
  const drop = useFileDrop((files) => { void uploadFiles(files); }, !readOnly && !uploading);
  const camera = useCameraCapture((files) => { void uploadFiles(files); }, { video: true, fileInput: () => cameraInputRef.current });
  const dropProps = readOnly ? {} : drop.dropZoneProps;
  const dropHighlight = drop.isDragging && "rounded-sm ring-2 ring-primary ring-offset-2 bg-primary/5";

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async (photo: CheckPhoto) => {
    if (!confirm(VIDEO_PATH.test(photo.objectPath) ? "Remove this video?" : "Remove this photo?")) return;
    try {
      await apiFetch(`/photos/${photo.id}`, { method: "DELETE" });
      await fetchPhotos();
      announcePhotosChanged(entityType, entityId, self.current);
      toast({ title: VIDEO_PATH.test(photo.objectPath) ? "Video removed" : "Photo removed" });
      // The focused control was removed with the photo: keep keyboard users
      // in the component rather than dropping focus to the page.
      requestAnimationFrame(() => {
        const next = addButtonRef.current
          ?? containerRef.current?.querySelector<HTMLElement>("button");
        next?.focus();
      });
    } catch (err: any) {
      toast({ title: "Failed to remove", description: err.message, variant: "destructive" });
    }
  };

  // ── Photo serving URL ─────────────────────────────────────────────────────

  const photoUrl = (objectPath: string) => `${apiBase}/storage${objectPath}${activeClientId ? `?clientId=${activeClientId}` : ""}`;
  const isVideo = (photo: CheckPhoto) => VIDEO_PATH.test(photo.objectPath);
  const photoLabel = (index: number) => `${isVideo(photos[index]!) ? "video" : "photo"} ${index + 1} of ${photos.length}`;
  // A video shows its first frame, with a play mark over it.
  const thumbnail = (photo: CheckPhoto, className: string) => isVideo(photo) ? (
    <span className="relative block h-full w-full">
      <video src={`${photoUrl(photo.objectPath)}#t=0.1`} muted playsInline preload="metadata" className={className} />
      <Play className="absolute inset-0 m-auto h-4 w-4 fill-white text-white drop-shadow" aria-hidden="true" />
    </span>
  ) : <img src={photoUrl(photo.objectPath)} alt="" className={className} />;

  const openLightbox = (photo: CheckPhoto, index: number, opener: HTMLElement) => {
    lightboxOpenerRef.current = opener;
    const label = photoLabel(index);
    setLightbox({ src: photoUrl(photo.objectPath), label: label[0]!.toUpperCase() + label.slice(1), video: isVideo(photo) });
  };
  const closeLightbox = useCallback(() => {
    setLightbox(null);
    const opener = lightboxOpenerRef.current;
    lightboxOpenerRef.current = null;
    // After the dialog unmounts.
    requestAnimationFrame(() => opener?.focus());
  }, []);
  const lightboxEl = lightbox && <Lightbox src={lightbox.src} label={lightbox.label} video={lightbox.video} onClose={closeLightbox} />;

  // Without `capture`, phones offer the camera and the photo library; the
  // camera input opens the camera straight away.
  const fileInput = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={MEDIA_INPUT_ACCEPT}
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChange}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept={MEDIA_INPUT_ACCEPT}
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChange}
      />
      {camera.dialog}
    </>
  );
  const status = (
    <span role="status" className="sr-only">{uploading ? "Uploading…" : ""}</span>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  const loadErrorNotice = loadError && (
    <div role="alert" className="text-xs text-destructive">
      Could not load photos: {loadError}
      <Button type="button" variant="ghost" size="sm" onClick={() => void fetchPhotos()}>
        Retry photos
      </Button>
    </div>
  );

  if (compact) {
    return (
      <div ref={containerRef} {...dropProps} className={cn("flex items-center gap-2 flex-wrap mt-1", dropHighlight)}>
        {status}
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" aria-label="Loading photos" />}
        {loadErrorNotice}
        {photos.map((p, index) => (
          <div key={p.id} className="relative group w-10 h-10 rounded-sm overflow-hidden border border-border flex-shrink-0">
            <button
              type="button"
              aria-label={`View ${photoLabel(index)}`}
              className={cn("block w-full h-full", focusRing)}
              onClick={(e) => openLightbox(p, index, e.currentTarget)}
            >
              {thumbnail(p, "w-full h-full object-cover")}
            </button>
            {!readOnly && <button
              type="button"
              aria-label={`Remove ${photoLabel(index)}`}
              onClick={() => handleDelete(p)}
              className={cn(
                "absolute top-0 right-0 w-4 h-4 bg-black/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 flex items-center justify-center transition-opacity",
                focusRing,
              )}
            >
              <X className="w-3 h-3 text-white" aria-hidden="true" />
            </button>}
          </div>
        ))}
        {!readOnly && <button
          ref={addButtonRef}
          type="button"
          aria-label={uploading ? "Uploading" : "Add photo or video"}
          disabled={uploading}
          aria-busy={uploading}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "w-10 h-10 rounded-sm border-2 border-dashed border-border flex items-center justify-center cursor-pointer",
            "hover:border-primary/50 hover:bg-muted/40 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-default",
            focusRing,
          )}
        >
          {uploading
            ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
            : <ImagePlus className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
          }
        </button>}
        {!readOnly && <button
          type="button"
          aria-label="Take photo or video"
          disabled={uploading}
          onClick={camera.open}
          className={cn(
            "w-10 h-10 rounded-sm border-2 border-dashed border-border flex items-center justify-center cursor-pointer",
            "hover:border-primary/50 hover:bg-muted/40 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-default",
            focusRing,
          )}
        >
          <Camera className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
        </button>}
        {!readOnly && fileInput}
        {required && (
          <Badge variant="outline" className={cn("text-xs",
            photos.length < minPhotos
              ? "text-amber-700 border-amber-300 bg-amber-50"
              : "text-emerald-700 border-emerald-300 bg-emerald-50")}>
            {minPhotos === 1 ? "Photo required" : `${minPhotos} photos required`} · {photos.length}/{minPhotos}
          </Badge>
        )}
        {lightboxEl}
      </div>
    );
  }

  return (
    <div ref={containerRef} {...dropProps} className={cn("space-y-2", dropHighlight)}>
      {status}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Photos and videos</span>
          {required && (
            <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">Required</Badge>
          )}
          {photos.length > 0 && (
            <span className="text-xs text-muted-foreground">{photos.length} attached</span>
          )}
        </div>
        {!readOnly && <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={uploading}
            onClick={camera.open}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm border border-border text-xs font-medium cursor-pointer",
              "hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-default",
              focusRing,
            )}
          >
            <Camera className="w-3.5 h-3.5" aria-hidden="true" /> Take photo or video
          </button>
          <button
            ref={addButtonRef}
            type="button"
            disabled={uploading}
            aria-busy={uploading}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm border border-border text-xs font-medium cursor-pointer",
              "hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-default",
              focusRing,
            )}
          >
            {uploading ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Uploading…</>
            ) : (
              <><ImagePlus className="w-3.5 h-3.5" aria-hidden="true" /> Choose files</>
            )}
          </button>
        </div>}
        {!readOnly && fileInput}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading photos…
        </div>
      )}

      {loadErrorNotice}
      {!loading && !loadError && photos.length === 0 && (
        <p className="text-xs text-muted-foreground italic py-1">
              {required ? `At least ${minPhotos} ${minPhotos === 1 ? "photo is" : "photos are"} required for this check.` : "No photos or videos attached."}
              {!readOnly && <span className="hidden sm:inline"> You can also drag them here.</span>}
        </p>
      )}

      {photos.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {photos.map((p, index) => (
            <div key={p.id} className="relative group aspect-square rounded-sm overflow-hidden border border-border">
              <span
                className="block w-full h-full cursor-pointer"
                onClick={(e) => openLightbox(p, index, e.currentTarget.parentElement?.querySelector("button") ?? e.currentTarget)}
              >
                {thumbnail(p, "w-full h-full object-cover transition-transform group-hover:scale-105")}
              </span>
              {/* Shown on hover and whenever one of its controls has keyboard focus. */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 group-focus-within:bg-black/30 transition-colors flex items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  aria-label={`View ${photoLabel(index)}`}
                  onClick={(e) => openLightbox(p, index, e.currentTarget)}
                  className={cn("p-1 bg-white/20 rounded text-white hover:bg-white/40 transition-colors", focusRing)}
                >
                  <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                {!readOnly && <button
                  type="button"
                  aria-label={`Remove ${photoLabel(index)}`}
                  onClick={() => handleDelete(p)}
                  className={cn("p-1 bg-white/20 rounded text-white hover:bg-red-500/80 transition-colors", focusRing)}
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {lightboxEl}
    </div>
  );
}
