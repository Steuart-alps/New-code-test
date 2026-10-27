import { useRef, useState, type ChangeEvent } from "react";
import { Camera, ImagePlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MediaGallery } from "@/components/media-gallery";
import { useAuth } from "@/context/auth-context";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { MEDIA_INPUT_ACCEPT, mediaContentType, mediaFileProblem, putFileWithProgress } from "@/lib/media-upload";
import { assertWithinUploadLimit } from "@/lib/upload-limits";
import { cn } from "@/lib/utils";

/**
 * Photos and videos kept as evidence on a track action (any track, Report
 * actions included). Files can be taken with the camera, picked, or dragged
 * onto the box while the action is still open; once it is resolved they are
 * shown only.
 */
export function ActionMedia({ actionId, mediaUrls, canAdd, onChange }: {
  actionId: number | string;
  mediaUrls: string[];
  canAdd: boolean;
  onChange: (mediaUrls: string[]) => void;
}) {
  const { activeClientId } = useAuth();
  const { toast } = useToast();
  const [progress, setProgress] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const uploading = progress !== null;

  async function upload(files: File[]) {
    if (!canAdd || uploading || files.length === 0) return;
    const failures: string[] = [];
    let added = 0;
    try {
      for (const [index, file] of files.entries()) {
        const counter = files.length > 1 ? ` ${index + 1} of ${files.length}` : "";
        try {
          const problem = mediaFileProblem(file);
          if (problem) throw new Error(problem);
          assertWithinUploadLimit(file);
          const contentType = mediaContentType(file);
          setProgress(`Preparing${counter}`);
          const presign = await apiFetch(`/track-actions/${actionId}/request-upload`, {
            method: "POST",
            body: JSON.stringify({ name: file.name.slice(0, 200), contentType }),
          });
          if (!presign.ok) throw new Error(await getApiErrorMessage(presign, "Couldn't prepare the upload."));
          const { uploadUrl, objectPath } = await presign.json();
          await putFileWithProgress(uploadUrl, file, contentType, (percent) => setProgress(`Uploading${counter}: ${percent}%`));
          setProgress(`Saving${counter}`);
          const attached = await apiFetch(`/track-actions/${actionId}/media`, {
            method: "POST",
            body: JSON.stringify({ objectPath }),
          });
          if (!attached.ok) throw new Error(await getApiErrorMessage(attached, "The file uploaded but couldn't be added to the action."));
          const body = await attached.json();
          if (Array.isArray(body?.mediaUrls)) onChange(body.mediaUrls);
          added += 1;
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : "Upload failed."}`);
        }
      }
    } finally {
      setProgress(null);
    }
    if (added > 0) toast({ title: added === 1 ? "Photo or video added" : `${added} photos and videos added` });
    if (failures.length > 0) toast({ title: "Some files weren't added", description: failures.join("\n"), variant: "destructive" });
  }

  function picked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void upload(files);
  }

  const drop = useFileDrop((files) => { void upload(files); }, canAdd && !uploading);

  if (!canAdd && mediaUrls.length === 0) return null;
  return (
    <div
      {...(canAdd ? drop.dropZoneProps : {})}
      className={cn("space-y-2", canAdd && "rounded-sm border border-dashed p-3 transition-colors", drop.isDragging ? "border-primary bg-primary/5" : "border-border")}
      data-testid={`action-media-${actionId}`}
    >
      <p className="text-sm font-medium text-[#162D42]">Photos and videos</p>
      <MediaGallery urls={mediaUrls} clientId={activeClientId} label="action photo or video" testIdPrefix={`action-media-${actionId}`} />
      {canAdd && (
        <>
          <input ref={cameraRef} type="file" accept={MEDIA_INPUT_ACCEPT} capture="environment" className="hidden" onChange={picked} />
          <input ref={pickRef} type="file" accept={MEDIA_INPUT_ACCEPT} multiple className="hidden" onChange={picked} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={uploading} onClick={() => cameraRef.current?.click()}>
              <Camera className="mr-1.5 h-4 w-4" />Take photo or video
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={uploading} onClick={() => pickRef.current?.click()}>
              <ImagePlus className="mr-1.5 h-4 w-4" />Choose files
            </Button>
            {uploading
              ? <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" />{progress}</span>
              : <span className="hidden text-xs text-muted-foreground sm:inline">or drag them here</span>}
          </div>
        </>
      )}
    </div>
  );
}
