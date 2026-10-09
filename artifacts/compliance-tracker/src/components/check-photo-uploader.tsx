/**
 * CheckPhotoUploader — reusable photo attachment component for any check record.
 *
 * Usage:
 *   <CheckPhotoUploader entityType="fire_safety_check" entityId={check.id} />
 *
 * The component lists existing photos, handles presigned-URL uploads, and
 * lets users delete photos. If `required` is true a badge is shown but no
 * enforcement is done here — the parent form decides whether to block submit.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { Camera, ImagePlus, Trash2, X, ZoomIn, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// ── API helpers ───────────────────────────────────────────────────────────────

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");

async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
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
function Lightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

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
      <img
        src={src}
        alt={label}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-2xl"
        onClick={e => e.stopPropagation()}
      />
    </div>
  );
}

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

// ── Main component ────────────────────────────────────────────────────────────

export function CheckPhotoUploader({
  entityType,
  entityId,
  required = false,
  compact = false,
  readOnly = false,
  onCountChange,
}: CheckPhotoUploaderProps) {
  const [photos, setPhotos] = useState<CheckPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // The control that opened the lightbox, so focus returns to it on close.
  const lightboxOpenerRef = useRef<HTMLElement | null>(null);
  const { toast } = useToast();

  // ── Fetch existing photos ─────────────────────────────────────────────────

  const fetchPhotos = useCallback(async () => {
    try {
      setLoading(true);
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
    } catch {
      // Silently fail — photos are supplementary
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, onCountChange]);

  useEffect(() => { fetchPhotos(); }, [fetchPhotos]);

  // ── Upload flow ───────────────────────────────────────────────────────────

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";

    if (!["image/jpeg", "image/png"].includes(file.type)) {
      toast({ title: "JPEG or PNG only", description: "Please select a JPEG or PNG image.", variant: "destructive" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum 10 MB per photo.", variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      // Step 1 — request presigned URL
      const { uploadUrl, objectPath } = await apiFetch<{ uploadUrl: string; objectPath: string }>(
        "/photos/request-upload",
        {
          method: "POST",
          body: JSON.stringify({ entityType, entityId, name: file.name, contentType: file.type }),
        }
      );

      // Step 2 — PUT file directly to GCS
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload to storage failed");

      // Step 3 — record in database
      await apiFetch("/photos", {
        method: "POST",
        body: JSON.stringify({ entityType, entityId, objectPath }),
      });

      await fetchPhotos();
      toast({ title: "Photo added" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async (photo: CheckPhoto) => {
    if (!confirm("Remove this photo?")) return;
    try {
      await apiFetch(`/photos/${photo.id}`, { method: "DELETE" });
      await fetchPhotos();
      toast({ title: "Photo removed" });
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

  const photoUrl = (objectPath: string) => `${apiBase}/storage${objectPath}`;
  const photoLabel = (index: number) => `photo ${index + 1} of ${photos.length}`;

  const openLightbox = (photo: CheckPhoto, index: number, opener: HTMLElement) => {
    lightboxOpenerRef.current = opener;
    setLightbox({ src: photoUrl(photo.objectPath), label: `Photo ${index + 1} of ${photos.length}` });
  };
  const closeLightbox = useCallback(() => {
    setLightbox(null);
    const opener = lightboxOpenerRef.current;
    lightboxOpenerRef.current = null;
    // After the dialog unmounts.
    requestAnimationFrame(() => opener?.focus());
  }, []);
  const lightboxEl = lightbox && <Lightbox src={lightbox.src} label={lightbox.label} onClose={closeLightbox} />;

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/jpeg,image/png"
      capture="environment"
      className="hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={handleFileChange}
    />
  );
  const status = (
    <span role="status" className="sr-only">{uploading ? "Uploading photo…" : ""}</span>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (compact) {
    return (
      <div ref={containerRef} className="flex items-center gap-2 flex-wrap mt-1">
        {status}
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" aria-label="Loading photos" />}
        {photos.map((p, index) => (
          <div key={p.id} className="relative group w-10 h-10 rounded-sm overflow-hidden border border-border flex-shrink-0">
            <button
              type="button"
              aria-label={`View ${photoLabel(index)}`}
              className={cn("block w-full h-full", focusRing)}
              onClick={(e) => openLightbox(p, index, e.currentTarget)}
            >
              <img src={photoUrl(p.objectPath)} alt="" className="w-full h-full object-cover" />
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
          aria-label={uploading ? "Uploading photo" : "Add photo"}
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
        {!readOnly && fileInput}
        {required && photos.length === 0 && (
          <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">Photo required</Badge>
        )}
        {lightboxEl}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-2">
      {status}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Photos</span>
          {required && (
            <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">Required</Badge>
          )}
          {photos.length > 0 && (
            <span className="text-xs text-muted-foreground">{photos.length} attached</span>
          )}
        </div>
        {!readOnly && <button
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
            <><Camera className="w-3.5 h-3.5" aria-hidden="true" /> Add Photo</>
          )}
        </button>}
        {!readOnly && fileInput}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading photos…
        </div>
      )}

      {!loading && photos.length === 0 && (
        <p className="text-xs text-muted-foreground italic py-1">
          {required ? "At least one photo is required for this check." : "No photos attached."}
        </p>
      )}

      {photos.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {photos.map((p, index) => (
            <div key={p.id} className="relative group aspect-square rounded-sm overflow-hidden border border-border">
              <img
                src={photoUrl(p.objectPath)}
                alt=""
                className="w-full h-full object-cover cursor-pointer transition-transform group-hover:scale-105"
                onClick={(e) => openLightbox(p, index, e.currentTarget.parentElement?.querySelector("button") ?? e.currentTarget)}
              />
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
