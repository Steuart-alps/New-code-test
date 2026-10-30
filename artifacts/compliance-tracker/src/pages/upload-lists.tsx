import { useRef, useState, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileSpreadsheet, Image as ImageIcon, Loader2, Sparkles, Upload, X } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { ImportCsvDialog, type ImportCsvType } from "@/components/import-csv-dialog";
import { SPREADSHEET_ACCEPT, isSpreadsheetFile, usePastedFile } from "@/components/spreadsheet-drop-zone";
import { AiAllowanceNote } from "@/components/ai-allowance-note";
import { READABLE_LIST, isPhotoOrPdf, listFileBody, useListReading } from "@/components/ai-list-reader";
import { MachineImportDialog } from "@/pages/green-track";
import { RosterImportDialog } from "@/components/roster-import-dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { getApiErrorMessage } from "@/lib/api";
import { LIST_KINDS, WORKBOOK_TABS, availableListKinds, guessListKind, guessListKindFromName, type ListKind } from "@/lib/list-kinds";
import { readSpreadsheet, spreadsheetTabNames } from "@/lib/spreadsheet";
import { cn } from "@/lib/utils";

/**
 * "Upload your lists": drop every existing list at once (contractors, staff,
 * rooms, PAT appliances, call points, GreenTrack machines). Each file is
 * sorted into its import: a spreadsheet by its column headings, a photo or
 * PDF by AI where the business has the add-on. Each one then opens in its
 * import's usual dialog to check and confirm, so nothing is saved unchecked.
 */

type ItemState = "sorting" | "ready" | "choose" | "error" | "done";
interface Item {
  id: number;
  file: File;
  kind: ListKind | null;
  state: ItemState;
  /** How the kind was found, or why it wasn't. */
  note: string;
}

const CSV_IMPORTS: Partial<Record<ListKind, ImportCsvType>> = {
  "pat-appliances": "pat-appliances",
  "room-track-rooms": "room-track-rooms",
  contractors: "contractors",
  "fire-call-points": "fire-call-points",
  "legionella-outlets": "legionella-outlets",
};

/** The page body, without the app frame (also used by its browser test). */
export function UploadLists() {
  const { hasService, activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();
  // The AI status for sorting photos and PDFs (the contractors import is open
  // to every owner and consultant, whatever their modules).
  const reading = useListReading("contractors", true);
  const kinds: ListKind[] = availableListKinds(hasService);
  const [items, setItems] = useState<Item[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const sites = useQuery({
    queryKey: ["sites", activeClientId],
    queryFn: async () => {
      const response = await clientApiFetch("/sites");
      return response.ok ? response.json() as Promise<Array<{ id: number; name: string }>> : [];
    },
  });

  const update = (id: number, change: Partial<Item>) => setItems(list => list.map(item => item.id === id ? { ...item, ...change } : item));

  async function sort(item: Item) {
    const { file } = item;
    if (isSpreadsheetFile(file)) {
      try {
        // A setup "What we need from you" workbook has several tabs: the
        // list is the tab named for it, which its import reads too.
        const tabs = await spreadsheetTabNames(file);
        const workbookKind = kinds.find(candidate => tabs.some(tab => tab.trim().toLowerCase() === WORKBOOK_TABS[candidate].toLowerCase()));
        const sheet = await readSpreadsheet(file, workbookKind ? { sheet: WORKBOOK_TABS[workbookKind] } : {});
        const kind = workbookKind ?? guessListKind(sheet.headers, file.name, kinds);
        update(item.id, kind
          ? { kind, state: "ready", note: `${sheet.rows.length} row${sheet.rows.length === 1 ? "" : "s"}, sorted by its column headings` }
          : { state: "choose", note: "Its column headings don't say which list it is. Choose one." });
      } catch (err) {
        update(item.id, { state: "error", note: err instanceof Error ? err.message : "This file could not be read" });
      }
      return;
    }
    if (!isPhotoOrPdf(file)) {
      update(item.id, { state: "error", note: "This isn't a spreadsheet, photo or PDF." });
      return;
    }
    const byName = guessListKindFromName(file.name, kinds);
    if (byName) {
      update(item.id, { kind: byName, state: "ready", note: "Sorted by its file name" });
      return;
    }
    if (!reading.canRead) {
      update(item.id, {
        state: "choose",
        note: reading.status ? "Choose which list it is. AI reads photos and PDFs with the AI features add-on." : "Choose which list it is.",
      });
      return;
    }
    try {
      const response = await clientApiFetch("/imports/sort-list", { method: "POST", body: JSON.stringify(await listFileBody(file)) });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "ComplyTrack could not sort this file"));
      const { kind } = await response.json() as { kind: ListKind | null };
      update(item.id, kind && kinds.includes(kind)
        ? { kind, state: "ready", note: "Sorted by AI" }
        : { state: "choose", note: "AI couldn't tell which list this is. Choose one." });
    } catch (err) {
      update(item.id, { state: "choose", note: `${err instanceof Error ? err.message : "ComplyTrack could not sort this file"}. Choose which list it is.` });
    }
  }

  function add(files: File[]) {
    const added = files.map(file => ({ id: nextId.current++, file, kind: null, state: "sorting" as const, note: "" }));
    setItems(list => [...list, ...added]);
    for (const item of added) void sort(item);
  }

  usePastedFile(reading.loaded && openId === null, file => add([file]));

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) add(files);
  }

  const open = items.find(item => item.id === openId) ?? null;
  const done = (id: number) => update(id, { state: "done", note: "Imported" });
  const close = () => setOpenId(null);

  return (
    <>
      <div className="max-w-3xl space-y-4">
        <p className="text-sm text-muted-foreground">
          Drop all your existing lists here at once: {kinds.map(kind => LIST_KINDS[kind].noun).join(", ")}.
          ComplyTrack works out which list each file is, then you check and import each one. Nothing is saved until you confirm it.
        </p>

        {!reading.loaded ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <input ref={input} type="file" multiple className="hidden" data-testid="input-upload-lists"
              accept={reading.canRead ? `${SPREADSHEET_ACCEPT},${READABLE_LIST}` : SPREADSHEET_ACCEPT}
              onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) add(files); }} />
            <button type="button" onClick={() => input.current?.click()}
              onDragEnter={event => { event.preventDefault(); setDragging(true); }}
              onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={drop}
              data-testid="drop-upload-lists"
              className={cn("w-full rounded-lg border-2 border-dashed bg-card p-8 text-center transition-colors",
                dragging ? "border-primary bg-primary/5" : "hover:border-primary/50 hover:bg-muted/20")}>
              <Upload className={cn("mx-auto mb-2 h-8 w-8", dragging ? "text-primary" : "text-muted-foreground opacity-50")} />
              <span className="block text-sm font-medium text-muted-foreground">
                {dragging ? "Drop the files here" : "Drag all your lists here, or click to choose them"}
              </span>
              <span className="block text-xs text-muted-foreground">
                {reading.canRead
                  ? "Excel, CSV and Word files are sorted by their column headings. Photos, screenshots, scans and PDFs are sorted by AI. You can also paste (Ctrl+V) a screenshot."
                  : "Excel, CSV and Word files, sorted by their column headings."}
              </span>
            </button>
            {reading.status && !reading.canRead && (
              <div className="flex items-start gap-1.5 rounded-lg border p-3 text-xs text-muted-foreground" data-testid="upload-lists-ai-note">
                <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                <div>
                  <p className="font-medium text-foreground">Only have a paper list, photo or PDF?</p>
                  <AiAllowanceNote ai={reading.status.ai} />
                </div>
              </div>
            )}
          </>
        )}

        {items.length > 0 && (
          <ul className="divide-y rounded-lg border bg-card" data-testid="upload-lists-files">
            {items.map(item => (
              <li key={item.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center" data-testid={`upload-list-${item.id}`}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {isSpreadsheetFile(item.file)
                    ? <FileSpreadsheet className="h-5 w-5 shrink-0 text-green-600" />
                    : <ImageIcon className="h-5 w-5 shrink-0 text-sky-600" />}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.file.name}</p>
                    <p className={cn("text-xs", item.state === "error" ? "text-destructive" : "text-muted-foreground")} data-testid={`upload-list-note-${item.id}`}>
                      {item.state === "sorting"
                        ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Working out which list this is…</span>
                        : item.note}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {item.state === "done" ? (
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {item.kind ? LIST_KINDS[item.kind].label : "Imported"}</span>
                  ) : item.state !== "error" && item.state !== "sorting" && (
                    <>
                      <select aria-label={`Which list is ${item.file.name}?`} data-testid={`select-upload-list-kind-${item.id}`}
                        className="h-9 rounded-sm border border-input bg-background px-2 text-sm"
                        value={item.kind ?? ""} onChange={event => update(item.id, event.target.value
                          ? { kind: event.target.value as ListKind, state: "ready" }
                          : { kind: null, state: "choose" })}>
                        <option value="">Choose which list…</option>
                        {kinds.map(kind => <option key={kind} value={kind}>{LIST_KINDS[kind].label}</option>)}
                      </select>
                      <Button type="button" size="sm" disabled={!item.kind} onClick={() => setOpenId(item.id)} data-testid={`button-upload-list-open-${item.id}`}>
                        Check and import
                      </Button>
                    </>
                  )}
                  {item.state !== "sorting" && (
                    <button type="button" aria-label={`Remove ${item.file.name}`} onClick={() => setItems(list => list.filter(other => other.id !== item.id))}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open?.kind && CSV_IMPORTS[open.kind] && (
        <ImportCsvDialog key={open.id} type={CSV_IMPORTS[open.kind]!} open initialFile={open.file}
          onOpenChange={value => { if (!value) close(); }} onImported={() => done(open.id)} />
      )}
      {open?.kind === "staff-roster" && (
        <RosterImportDialog key={open.id} open initialFile={open.file} sites={sites.data ?? []}
          onClose={close} onImported={() => done(open.id)} />
      )}
      {open?.kind === "greentrack-equipment" && (
        <MachineImportDialog key={open.id} open initialFile={open.file} sites={sites.data ?? []} defaultSiteId={null}
          onClose={close} onImported={() => done(open.id)} />
      )}
    </>
  );
}

export default function UploadListsPage() {
  return <AppLayout title="Upload your lists"><UploadLists /></AppLayout>;
}
