import { useEffect, useMemo, useRef, type ChangeEvent } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useToast } from "@/hooks/use-toast";
import { MEDIA_INPUT_ACCEPT, mediaFileProblem } from "@/lib/media-upload";
import { cn } from "@/lib/utils";

/**
 * Photos and videos chosen in a "new" form before the record exists. They
 * stay in the browser and are uploaded straight after the record is saved, so
 * nothing is stored (or charged for) if the form is cancelled.
 */
export function PendingMediaPicker({ files, onChange, disabled = false, label = "Photos and videos", testId = "pending-media" }: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
}) {
  const { toast } = useToast();
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map(file => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previews.forEach(url => URL.revokeObjectURL(url)), [previews]);

  function add(picked: File[]) {
    const accepted: File[] = [];
    for (const file of picked) {
      const problem = mediaFileProblem(file);
      if (problem) toast({ title: `${file.name} can't be added`, description: problem, variant: "destructive" });
      else accepted.push(file);
    }
    if (accepted.length > 0) onChange([...files, ...accepted]);
  }
  function picked(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    add(chosen);
  }
  const drop = useFileDrop(add, !disabled);

  return (
    <div
      {...drop.dropZoneProps}
      className={cn("space-y-2 rounded-sm border border-dashed p-3 transition-colors", drop.isDragging ? "border-primary bg-primary/5" : "border-border")}
      data-testid={testId}
    >
      <p className="text-sm font-medium">{label} <span className="font-normal text-muted-foreground">(optional)</span></p>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file, index) => (
            <div key={`${file.name}-${index}`} className="relative h-20 w-20 overflow-hidden rounded-sm border bg-muted">
              {file.type.startsWith("video/")
                ? <video src={previews[index]} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                : <img src={previews[index]} alt={file.name} className="h-full w-full object-cover" />}
              <button type="button" disabled={disabled} aria-label={`Remove ${file.name}`}
                onClick={() => onChange(files.filter((_, at) => at !== index))}
                className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <input ref={cameraRef} type="file" accept={MEDIA_INPUT_ACCEPT} capture="environment" className="hidden" onChange={picked} />
      <input ref={pickRef} type="file" accept={MEDIA_INPUT_ACCEPT} multiple className="hidden" onChange={picked} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => cameraRef.current?.click()}>
          <Camera className="mr-1.5 h-4 w-4" />Take photo or video
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => pickRef.current?.click()}>
          <ImagePlus className="mr-1.5 h-4 w-4" />Choose files
        </Button>
        <span className="hidden text-xs text-muted-foreground sm:inline">or drag them here</span>
      </div>
      {files.length > 0 && <p className="text-xs text-muted-foreground">They upload when you save.</p>}
    </div>
  );
}
