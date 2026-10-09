import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ImagePlus, Trash2 } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { usePhotoRequirements } from "@/hooks/use-photo-requirements";
import { getApiErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface StagedPhoto {
  id: string;
  name: string;
}

export function useNewRecordPhotoEvidence(entityType: string, enabled = true) {
  const { user, activeClientId } = useAuth();
  const request = useActiveClientApi();
  const rules = usePhotoRequirements();
  const scope = `${user?.id}:${activeClientId}:${entityType}:${enabled}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [state, setState] = useState<{ scope: string; photos: StagedPhoto[] }>({ scope, photos: [] });
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{ scope: string; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const photos = state.scope === scope ? state.photos : [];
  const uploading = busyScope === scope;
  const requirement = rules.requirements[entityType];
  const required = requirement?.required ?? false;
  const minimum = requirement?.minPhotos ?? 1;
  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({ scope, photos: [] });
    setBusyScope(null);
    setUploadError(null);
  }, [scope]);

  useEffect(() => {
    reset();
    return () => { abortRef.current?.abort(); };
  }, [reset]);

  const addFile = async (file: File) => {
    if (!enabled || uploading || photos.length >= 10 || abortRef.current) return;
    if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setUploadError({ scope, message: "Select a JPEG or PNG image no larger than 10 MB." });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusyScope(scope);
    setUploadError(null);
    try {
      const uploadResponse = await request("/photos/request-staged-upload", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ entityType, name: file.name, contentType: file.type }),
      });
      if (!uploadResponse.ok) {
        throw new Error(await getApiErrorMessage(uploadResponse, "Could not prepare photo upload."));
      }
      const upload = await uploadResponse.json() as { uploadUrl?: string; objectPath?: string };
      if (!upload.uploadUrl || !upload.objectPath) throw new Error("Invalid photo upload response.");
      const put = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
        signal: controller.signal,
      });
      if (!put.ok) throw new Error("Upload to storage failed. Please retry.");
      const stagedResponse = await request("/photos/staged", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ entityType, objectPath: upload.objectPath }),
      });
      if (!stagedResponse.ok) {
        throw new Error(await getApiErrorMessage(stagedResponse, "Could not verify photo upload."));
      }
      const staged = await stagedResponse.json() as { id?: string };
      if (!staged.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staged.id)) {
        throw new Error("Invalid photo verification response.");
      }
      if (currentScope.current === scope && !controller.signal.aborted) {
        setState(previous => ({
          scope,
          photos: [...(previous.scope === scope ? previous.photos : []), { id: staged.id!, name: file.name }],
        }));
      }
    } catch (error) {
      if (currentScope.current === scope && !controller.signal.aborted) {
        setUploadError({ scope, message: error instanceof Error ? error.message : "Photo upload failed." });
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (currentScope.current === scope) setBusyScope(null);
      }
    }
  };

  return {
    enabled,
    required,
    minimum,
    loading: rules.isLoading,
    error: rules.error,
    retry: rules.retry,
    uploading,
    photos,
    uploadIds: photos.map(photo => photo.id),
    ready: !enabled || (!rules.isLoading && !rules.error && !uploading
      && (!required || photos.length >= minimum)),
    uploadError: uploadError?.scope === scope ? uploadError.message : null,
    addFile,
    removePhoto: (id: string) => setState(previous => ({
      scope,
      photos: previous.scope === scope ? previous.photos.filter(photo => photo.id !== id) : [],
    })),
    reset,
  };
}

export function RequiredRecordPhotoEvidence({
  evidence,
}: { evidence: ReturnType<typeof useNewRecordPhotoEvidence> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (!evidence.enabled) return null;
  if (evidence.loading) return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading photo requirements…
    </p>
  );
  if (evidence.error) return (
    <div role="alert" className="text-sm text-destructive">
      Could not load photo requirements. Saving is unavailable until they can be checked.
      <Button type="button" variant="ghost" onClick={evidence.retry}>Retry photo requirements</Button>
    </div>
  );
  if (!evidence.required) return null;
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3" aria-label="Required photo evidence">
      <legend className="px-1 text-sm font-medium">Required photo evidence</legend>
      <Badge variant="outline">{evidence.photos.length}/{evidence.minimum} required photos attached</Badge>
      <p className="text-xs text-muted-foreground">
        Attach at least {evidence.minimum} verified {evidence.minimum === 1 ? "photo" : "photos"} before saving.
      </p>
      {evidence.photos.map(photo => (
        <div key={photo.id} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{photo.name} — ready to attach</span>
          <Button type="button" variant="ghost" size="sm" disabled={evidence.uploading}
            aria-label={`Remove ${photo.name}`} onClick={() => evidence.removePhoto(photo.id)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {evidence.uploadError && <p role="alert" className="text-sm text-destructive">{evidence.uploadError}</p>}
      <Button type="button" variant="outline"
        disabled={evidence.uploading || evidence.photos.length >= 10}
        onClick={() => inputRef.current?.click()}>
        {evidence.uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
        {evidence.uploading ? "Verifying photo…" : "Add required photo"}
      </Button>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png" capture="environment"
        aria-label="Select required photo" className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void evidence.addFile(file);
        }} />
    </fieldset>
  );
}