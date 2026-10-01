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
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useAuth } from "@/context/auth-context";

// ── API helpers ───────────────────────────────────────────────────────────────

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");

async function parsePhotoResponse<T = any>(res: Response): Promise<T> {
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

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors"
        onClick={onClose}
      >
        <X className="w-6 h-6" />
      </button>
      <img
        src={src}
        alt="Full size"
        className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-2xl"
        onClick={e => e.stopPropagation()}
      />
    </div>
  );
}

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
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

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
    } catch (err: any) {
      toast({ title: "Failed to remove", description: err.message, variant: "destructive" });
    }
  };

  // ── Photo serving URL ─────────────────────────────────────────────────────

  const photoUrl = (objectPath: string) => `${apiBase}/storage${objectPath}${activeClientId ? `?clientId=${activeClientId}` : ""}`;

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
      <div className="flex items-center gap-2 flex-wrap mt-1">
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
        {loadErrorNotice}
        {photos.map(p => (
          <div key={p.id} className="relative group w-10 h-10 rounded-sm overflow-hidden border border-border flex-shrink-0">
            <img
              src={photoUrl(p.objectPath)}
              alt="Check photo"
              className="w-full h-full object-cover cursor-pointer"
              onClick={() => setLightboxSrc(photoUrl(p.objectPath))}
            />
            {!readOnly && <button
              onClick={() => handleDelete(p)}
              className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
            >
              <X className="w-3 h-3 text-white" />
            </button>}
          </div>
        ))}
        {!readOnly && <label className={cn(
          "w-10 h-10 rounded-sm border-2 border-dashed border-border flex items-center justify-center cursor-pointer",
          "hover:border-primary/50 hover:bg-muted/40 transition-colors flex-shrink-0",
          uploading && "opacity-50 pointer-events-none"
        )}>
          {uploading
            ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            : <ImagePlus className="w-3.5 h-3.5 text-muted-foreground" />
          }
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
        </label>}
        {required && (
          <Badge variant="outline" className={cn("text-xs",
            photos.length < minPhotos
              ? "text-amber-700 border-amber-300 bg-amber-50"
              : "text-emerald-700 border-emerald-300 bg-emerald-50")}>
            {minPhotos === 1 ? "Photo required" : `${minPhotos} photos required`} · {photos.length}/{minPhotos}
          </Badge>
        )}
        {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      </div>
    );
  }

  return (
    <div className="space-y-2">
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
        {!readOnly && <label className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm border border-border text-xs font-medium cursor-pointer",
          "hover:bg-muted/50 transition-colors",
          uploading && "opacity-50 pointer-events-none"
        )}>
          {uploading ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading…</>
          ) : (
            <><Camera className="w-3.5 h-3.5" /> Add Photo</>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
        </label>}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading photos…
        </div>
      )}

      {loadErrorNotice}
      {!loading && !loadError && photos.length === 0 && (
        <p className="text-xs text-muted-foreground italic py-1">
              {required ? `At least ${minPhotos} ${minPhotos === 1 ? "photo is" : "photos are"} required for this check.` : "No photos attached."}
        </p>
      )}

      {photos.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {photos.map(p => (
            <div key={p.id} className="relative group aspect-square rounded-sm overflow-hidden border border-border">
              <img
                src={photoUrl(p.objectPath)}
                alt="Check photo"
                className="w-full h-full object-cover cursor-pointer transition-transform group-hover:scale-105"
                onClick={() => setLightboxSrc(photoUrl(p.objectPath))}
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => setLightboxSrc(photoUrl(p.objectPath))}
                  className="p-1 bg-white/20 rounded text-white hover:bg-white/40 transition-colors"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                {!readOnly && <button
                  onClick={() => handleDelete(p)}
                  className="p-1 bg-white/20 rounded text-white hover:bg-red-500/80 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}
