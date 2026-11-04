import { useRef } from "react";
import { Loader2, Sparkles, UploadCloud } from "lucide-react";
import type { AiStatus } from "@workspace/api-client-react";
import { AiAllowanceNote, aiAllowanceState } from "@/components/ai-allowance-note";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useFileDrop } from "@/hooks/use-file-drop";
import { CERTIFICATE_INPUT_ACCEPT } from "@/lib/certificate-files";
import { cn } from "@/lib/utils";

// The drop box at the top of COSHHTrack's New assessment form (Steuart,
// 2026-11-04: "drag and drop safety data sheet to create COSHH assessment").
// With "Fill it in with AI" on, the sheet is read and the form filled in for
// the person to check; with it off (or without the AI features add-on) the
// sheet is only attached, to fill the form in by hand.

const AI_CHOICE_KEY = "complytrack.coshh-sds-ai";

/** The person's last choice for the AI switch (on unless they turned it off). */
export function savedAiChoice(): boolean {
  try { return window.localStorage.getItem(AI_CHOICE_KEY) !== "off"; } catch { return true; }
}
export function saveAiChoice(on: boolean) {
  try { window.localStorage.setItem(AI_CHOICE_KEY, on ? "on" : "off"); } catch { /* private window: not remembered */ }
}

export interface SdsReadingStatus { available: boolean; ai: AiStatus }

export function CoshhSdsDrop({ status, useAi, onUseAiChange, busy, fileName, sheetUrl, onFiles, onReadNow, readDone }: {
  status: SdsReadingStatus | undefined;
  useAi: boolean;
  onUseAiChange: (on: boolean) => void;
  busy: "attaching" | "reading" | null;
  /** The sheet already dropped, if any. */
  fileName: string | null;
  /** A link to open the dropped sheet beside the form. */
  sheetUrl: string | null;
  onFiles: (files: File[]) => void;
  /** Read the sheet already dropped (it was attached with the AI off). */
  onReadNow: () => void;
  /** The form was already filled in from this sheet. */
  readDone: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const canUseAi = !!status?.available && aiAllowanceState(status.ai).canUse;
  const aiOn = useAi && canUseAi;
  const { isDragging, dropZoneProps } = useFileDrop((files) => onFiles(files), busy === null);

  return (
    <div className="space-y-2" data-testid="coshh-sds-drop">
      <div
        {...dropZoneProps}
        className={cn(
          "border-2 border-dashed rounded-xl p-4 flex flex-col items-center justify-center text-center bg-muted/20",
          isDragging ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        {busy ? (
          <>
            <Loader2 className="w-7 h-7 text-primary mb-1.5 animate-spin" aria-hidden="true" />
            <p className="text-sm font-medium">{busy === "reading" ? "Reading the safety data sheet…" : "Attaching the safety data sheet…"}</p>
            {busy === "reading" && <p className="text-xs text-muted-foreground mt-1">This usually takes about a minute.</p>}
          </>
        ) : (
          <>
            <UploadCloud className="w-7 h-7 text-muted-foreground mb-1.5" aria-hidden="true" />
            <p className="text-sm font-medium">
              {fileName ? `Safety data sheet: ${fileName}` : "Drag the safety data sheet here, or"}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
              <Button type="button" size="sm" variant={fileName ? "outline" : "default"} onClick={() => input.current?.click()}>
                {fileName ? "Choose a different sheet" : "Choose the sheet"}
              </Button>
              {sheetUrl && (
                <Button type="button" size="sm" variant="outline" asChild>
                  <a href={sheetUrl} target="_blank" rel="noreferrer">Open the sheet</a>
                </Button>
              )}
              {fileName && !readDone && canUseAi && (
                <Button type="button" size="sm" variant="outline" onClick={onReadNow}>
                  <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" /> Fill in from the sheet with AI
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-2">A PDF, photos of its pages (up to 10) or a Word file.</p>
            <input ref={input} type="file" multiple className="hidden" accept={CERTIFICATE_INPUT_ACCEPT}
              onChange={(e) => { const chosen = Array.from(e.target.files ?? []); e.target.value = ""; if (chosen.length) onFiles(chosen); }} />
          </>
        )}
      </div>
      <div className="flex items-start gap-2">
        <Switch id="coshh-sds-ai" className="mt-0.5" checked={aiOn} disabled={!canUseAi || busy !== null}
          onCheckedChange={(on) => onUseAiChange(on)} aria-describedby="coshh-sds-ai-note" />
        <div className="space-y-0.5">
          <label htmlFor="coshh-sds-ai" className="text-sm font-medium flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5 text-violet-600" aria-hidden="true" /> Fill it in with AI
          </label>
          <p id="coshh-sds-ai-note" className="text-xs text-muted-foreground">
            {!status ? "Checking whether the AI is available…"
              : !status.available ? "Reading safety data sheets with AI is not switched on yet. The sheet is attached and you fill the form in by hand."
              : aiOn ? "ComplyTrack reads the sheet and fills in the form. You check every section before saving."
              : canUseAi ? "Off: the sheet is attached and you fill the form in by hand. Nothing is used from the AI allowance."
              : null}
            {status?.available && (!canUseAi || aiOn) && <> <AiAllowanceNote ai={status.ai} /></>}
          </p>
        </div>
      </div>
    </div>
  );
}
