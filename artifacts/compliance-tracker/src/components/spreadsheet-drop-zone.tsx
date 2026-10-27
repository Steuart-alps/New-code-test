import { useRef, useState, type DragEvent } from "react";
import { FileSpreadsheet } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * File picker filter for imports: Excel first; CSV, a Word table or a text
 * list (one record per line) also work. Old .doc files are let through so the
 * reader can say how to save them as .docx.
 */
export const SPREADSHEET_ACCEPT = ".xlsx,.xls,.csv,.docx,.doc,.txt";

/** True when a file is one the import reader handles (or explains), by its name or type. */
export function isSpreadsheetFile(file: File): boolean {
  return /\.(xlsx|xls|csv|docx|doc|txt|tsv)$/i.test(file.name)
    || ["text/csv", "text/plain", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(file.type);
}

/**
 * The "choose or drag in a spreadsheet" box used by every import. A file can
 * be clicked to pick, or dragged in from another window or screen.
 */
export function SpreadsheetDropZone({ onFile, testId, accept = SPREADSHEET_ACCEPT, hint = "Excel or CSV. A Word table, or a list with commas or tabs between the values, works too.", className }: {
  onFile: (file: File) => void;
  /** data-testid for the hidden file input. */
  testId?: string;
  accept?: string;
  hint?: string;
  className?: string;
}) {
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
          {dragging ? "Drop the file here" : "Drag your Excel spreadsheet here, or click to choose it"}
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </button>
    </>
  );
}
