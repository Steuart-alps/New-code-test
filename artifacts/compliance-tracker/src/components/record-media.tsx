import { useCallback, useEffect, useState } from "react";
import { PendingMediaPicker } from "@/components/pending-media-picker";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { getApiErrorMessage } from "@/lib/api";
import { mediaContentType } from "@/lib/media-upload";
import { assertWithinUploadLimit } from "@/lib/upload-limits";

/**
 * Photos and videos for a "Record …" form, before the record exists: render
 * `picker` in the form, call `attach(newRecord.id)` once the record is saved
 * (before refreshing the list, so its photo strip shows them), and `clear()`
 * when the form is reset. Until then nothing is uploaded, so a cancelled form
 * stores nothing. Saved records add more through CheckPhotoUploader. Pass the
 * form's `open` to clear the picked files whenever the form closes.
 */
export function useRecordMedia(entityType: string, { open, disabled = false, testId }: { open?: boolean; disabled?: boolean; testId?: string } = {}) {
  const request = useActiveClientApi();
  const { toast } = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [attaching, setAttaching] = useState(false);
  useEffect(() => { if (open === false) setFiles([]); }, [open]);

  // `as` attaches them to another kind of record the save created instead,
  // such as the check saved with a bike hire.
  const attach = useCallback(async (entityId: number | null | undefined, as = entityType) => {
    if (files.length === 0) return;
    if (!entityId) {
      toast({ title: "Photos and videos weren't added", description: "The record was saved. Add them from its photo box.", variant: "destructive" });
      return;
    }
    setAttaching(true);
    const failures: string[] = [];
    try {
      for (const file of files) {
        try {
          assertWithinUploadLimit(file);
          const contentType = mediaContentType(file);
          const reserved = await request("/photos/request-upload", {
            method: "POST",
            body: JSON.stringify({ entityType: as, entityId, name: file.name.slice(0, 200), contentType }),
          });
          if (!reserved.ok) throw new Error(await getApiErrorMessage(reserved, "Could not get an upload link"));
          const { uploadUrl, objectPath } = await reserved.json() as { uploadUrl: string; objectPath: string };
          const put = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": contentType } });
          if (!put.ok) throw new Error("Upload to storage failed");
          const added = await request("/photos", { method: "POST", body: JSON.stringify({ entityType: as, entityId, objectPath }) });
          if (!added.ok) throw new Error(await getApiErrorMessage(added, "The file uploaded but couldn't be added to the record"));
        } catch (err) {
          failures.push(`${file.name}: ${err instanceof Error ? err.message : "Upload failed"}`);
        }
      }
    } finally {
      setAttaching(false);
      setFiles([]);
    }
    if (failures.length > 0) {
      toast({
        title: failures.length === files.length ? "Photos and videos weren't added" : "Some files weren't added",
        description: `The record was saved. Add them again from its photo box.\n${failures.join("\n")}`,
        variant: "destructive",
      });
    }
  }, [entityType, files, request, toast]);

  const clear = useCallback(() => setFiles([]), []);
  const picker = <PendingMediaPicker files={files} onChange={setFiles} disabled={disabled || attaching} testId={testId} />;
  return { files, picker, attaching, attach, clear };
}
