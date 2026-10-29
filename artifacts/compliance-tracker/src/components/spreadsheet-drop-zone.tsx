import { useEffect, useRef, useState, type DragEvent } from "react";
import { FileSpreadsheet } from "lucide-react";
import { READABLE_LIST } from "@/components/ai-list-reader";
import { cn } from "@/lib/utils";

/**
 * File picker filter for imports: Excel first; CSV, an OpenDocument sheet, a
 * Word table (.docx or the older .doc) or a text list (one record per line)
 * also work.
 */
export const SPREADSHEET_ACCEPT = ".xlsx,.xls,.csv,.ods,.docx,.doc,.txt";

/** True when a file is one the import reader handles (or explains), by its name or type. */
export function isSpreadsheetFile(file: File): boolean {
  return /\.(xlsx|xls|csv|ods|docx|doc|txt|tsv)$/i.test(file.name)
    || ["text/csv", "text/plain", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.spreadsheet", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(file.type);
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/**
 * Paste into an import (Ctrl+V or Cmd+V) while `active`: cells copied from
 * Excel arrive as a tab-separated list, and a screenshot on the clipboard as a
 * picture. Pasting into a text box is left alone.
 */
export function usePastedFile(active: boolean, onFile: (file: File) => void) {
  const latest = useRef(onFile);
  latest.current = onFile;
  useEffect(() => {
    if (!active) return;
    function paste(event: ClipboardEvent) {
      const data = event.clipboardData;
      if (!data) return;
      const text = data.getData("text/plain");
      // Excel also puts a picture of copied cells on the clipboard, so its
      // rows (text with tabs or line breaks) win over the picture.
      if (/[\t\n]/.test(text.trim())) {
        if (isTyping(event.target)) return;
        event.preventDefault();
        latest.current(new File([text], "pasted-from-clipboard.txt", { type: "text/plain" }));
        return;
      }
      const file = data.files?.[0];
      if (!file || (isTyping(event.target) && text)) return;
      event.preventDefault();
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      latest.current(file.name && file.name !== "image.png" ? file : new File([file], `pasted-screenshot.${ext}`, { type: file.type }));
    }
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [active]);
}

/**
 * The "choose or drag in a spreadsheet" box used by every import. A file can
 * be clicked to pick, or dragged in from another window or screen.
 */
export function SpreadsheetDropZone({ onFile, testId, aiReading = false, accept = aiReading ? `${SPREADSHEET_ACCEPT},${READABLE_LIST}` : SPREADSHEET_ACCEPT, hint, className }: {
  onFile: (file: File) => void;
  /** data-testid for the hidden file input. */
  testId?: string;
  /** With the AI add-on, the same box also takes a photo, screenshot or PDF of a list. */
  aiReading?: boolean;
  accept?: string;
  hint?: string;
  className?: string;
}) {
  hint ??= aiReading
    ? "Excel or CSV is read straight in. A photo, screenshot, scan or PDF of a list is read by AI. You can also paste (Ctrl+V) a screenshot or cells copied from Excel."
    : "Excel or CSV. A Word table, or a list with commas or tabs between the values, works too. You can also paste (Ctrl+V) cells copied from Excel.";
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  return (
    <>
      <input ref={input} type="file" accept={accept} className="hidden" data-testid={testId}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onFile(file); }} />
      <button type="button" onClick={() => input.current?.click()}
        onDragEnter={event => { event.preventDefault(); setDragging(true); }}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={drop}
        data-testid={testId ? `${testId}-drop` : undefined}
        className={cn("w-full rounded-lg border-2 border-dashed p-6 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "hover:border-primary/50 hover:bg-muted/20", className)}>
        <FileSpreadsheet className={cn("mx-auto mb-2 h-8 w-8", dragging ? "text-primary" : "text-muted-foreground opacity-50")} />
        <span className="block text-sm font-medium text-muted-foreground">
          {dragging ? "Drop the file here" : aiReading ? "Drag your spreadsheet, photo or PDF here, or click to choose it" : "Drag your Excel spreadsheet here, or click to choose it"}
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </button>
    </>
  );
}
