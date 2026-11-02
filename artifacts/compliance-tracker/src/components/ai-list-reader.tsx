import { useRef, useState, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, Download, Sparkles } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { getApiErrorMessage } from "@/lib/api";
import { heicToJpeg } from "@/lib/media-upload";
import { oldWordPlainText } from "@/lib/word-doc";
import { AiAllowanceNote, aiAllowanceState } from "@/components/ai-allowance-note";
import type { AiStatus } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWorkingSiteId } from "@/hooks/use-working-site";

/**
 * "Only have a paper list, photo or PDF?": with the AI features add-on,
 * ComplyTrack reads a photo, scan, PDF or Word list into the rows of an
 * import, which then go through that import's usual preview. Spreadsheets
 * never come here; the browser reads those itself (lib/spreadsheet.ts).
 */

export type ListReadingKind = "pat-appliances" | "room-track-rooms" | "contractors" | "fire-call-points" | "greentrack-equipment" | "staff-roster" | "allergen-ingredients" | "legionella-outlets";

interface ListReadingStatus { available: boolean; monthlyLimit: number; usedThisMonth: number; ai: AiStatus; sites: Array<{ id: number; name: string }> }
export interface ListReadResult { headers: string[]; rows: string[][]; unclear: number; unclearRows: number[] }

/** The PATTrack register has its own reader; the other imports share one. */
const readingPath = (kind: ListReadingKind) => kind === "pat-appliances" ? "/imports/pat-appliances/reading" : `/imports/list-reading/${kind}`;
const readPath = (kind: ListReadingKind) => kind === "pat-appliances" ? "/imports/pat-appliances/read" : `/imports/list-reading/${kind}/read`;

/**
 * File types ComplyTrack can read a list from (spreadsheets go the usual way).
 * Any photo or screenshot the browser can open is accepted; ones Claude can't
 * take directly (an iPhone HEIC, a TIFF scan) are turned into a JPEG first.
 */
export const READABLE_LIST = "image/*,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.tif,.tiff,.bmp,.pdf,.docx,.doc,.txt";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", avif: "image/avif",
};
/** Image types the AI reader takes as they are. */
const SENDABLE_IMAGE = /^image\/(jpeg|png|webp|gif)$/;

export function listMimeType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ext === "pdf" ? "application/pdf" : ext === "docx" ? DOCX_TYPE : ext === "txt" ? "text/plain" : IMAGE_EXTENSIONS[ext] ?? "";
}

/** True for a photo, screenshot or PDF, which only the reader can turn into rows. */
export function isPhotoOrPdf(file: File): boolean {
  return /^image\/|^application\/pdf$/.test(listMimeType(file));
}

/**
 * A phone photo can be 5-10 MB; Claude reads a list just as well at 2,000
 * pixels, so photos are shrunk to a JPEG of that size before upload. Photos
 * in other formats (HEIC, TIFF, BMP) are always turned into a JPEG.
 */
async function shrinkPhoto(file: File, mimeType: string): Promise<{ blob: Blob; mimeType: string }> {
  if (!mimeType.startsWith("image/") || mimeType === "image/gif") return { blob: file, mimeType };
  const sendable = SENDABLE_IMAGE.test(mimeType);
  const cannotOpen = new Error("This photo can't be opened in this browser. Save it as a JPEG or PNG (or take a screenshot of it) and try again.");
  if (typeof createImageBitmap !== "function") {
    if (sendable) return { blob: file, mimeType };
    throw cannotOpen;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    if (sendable && scale === 1 && file.size <= 1_500_000) { bitmap.close(); return { blob: file, mimeType }; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (blob) return { blob, mimeType: "image/jpeg" };
  } catch {
    // Not an image this browser can open.
  }
  if (sendable) return { blob: file, mimeType };
  throw cannotOpen;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.readAsDataURL(blob);
  });
}

/**
 * A list file as the AI reader takes it: an iPhone HEIC photo becomes a JPEG
 * where the browser can open it (Safari), photos are shrunk, and an old Word
 * file is sent as its text.
 */
export async function listFileBody(file: File): Promise<{ fileName: string; mimeType: string; data: string }> {
  const photo = /\.doc$/i.test(file.name) || file.type === "application/msword"
    ? new File([oldWordPlainText(new Uint8Array(await file.arrayBuffer()))], file.name.replace(/\.doc$/i, ".txt"), { type: "text/plain" })
    : await heicToJpeg(file);
  const shrunk = await shrinkPhoto(photo, listMimeType(photo));
  return { fileName: file.name, mimeType: shrunk.mimeType, data: await toBase64(shrunk.blob) };
}

/**
 * Whether this business can have a list read for an import, and the call that
 * reads one. `status` is null while reading is unavailable (no API key, or the
 * import is closed).
 */
export function useListReading(kind: ListReadingKind, enabled: boolean, defaultSiteId?: number | null) {
  const { activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();
  // The caller's site, else the user's working site, until one is picked.
  const workingSiteId = useWorkingSiteId();
  const [chosenSiteId, setSiteId] = useState<string | null>(null);
  const siteId = chosenSiteId ?? (defaultSiteId ? String(defaultSiteId) : workingSiteId ? String(workingSiteId) : "");
  const query = useQuery({
    queryKey: ["imports", kind, "reading", activeClientId],
    enabled,
    queryFn: async () => {
      const response = await clientApiFetch(readingPath(kind));
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not check reading"));
      return response.json() as Promise<ListReadingStatus>;
    },
  });
  const status = query.data?.available ? query.data : null;
  const readsLeft = status && status.monthlyLimit > 0 ? Math.max(0, status.monthlyLimit - status.usedThisMonth) : null;
  const canRead = !!status && readsLeft !== 0 && aiAllowanceState(status.ai).canUse;

  async function read(file: File): Promise<ListReadResult> {
    try {
      const response = await clientApiFetch(readPath(kind), {
        method: "POST",
        body: JSON.stringify({ ...await listFileBody(file), siteId: siteId ? Number(siteId) : null }),
      });
      const body = await response.json().catch(() => null) as (Partial<ListReadResult> & { error?: string }) | null;
      if (!response.ok || !body?.headers || !body.rows) throw new Error(body?.error ?? "ComplyTrack could not read this list");
      return { headers: body.headers, rows: body.rows, unclear: body.unclear ?? 0, unclearRows: body.unclearRows ?? [] };
    } finally {
      void query.refetch();
    }
  }

  return { status, loaded: !query.isPending, readsLeft, canRead, read, siteId, setSiteId };
}

export type ListReading = ReturnType<typeof useListReading>;

/** The box offering to read a paper list, photo or PDF. Renders nothing when reading is unavailable. */
export function ListReadingPanel({ reading, kind, noun, onFile, onSpreadsheet, disabled }: {
  reading: ListReading; kind: ListReadingKind;
  /** Plural, for the wording: "appliances", "contractors". */
  noun: string;
  onFile: (file: File) => void;
  /** An Excel or CSV file dropped here by mistake goes the usual spreadsheet way. */
  onSpreadsheet?: (file: File) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { status, readsLeft, canRead } = reading;
  if (!status) return null;
  const usable = canRead && !disabled;

  function chosen(file: File) {
    if (onSpreadsheet && /\.(xlsx|xls|csv|ods)$/i.test(file.name)) onSpreadsheet(file);
    else if (usable) onFile(file);
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) chosen(file);
  }

  return (
    <div className={cn("space-y-2 rounded-lg border p-3 transition-colors", dragging && usable && "border-primary bg-primary/5")} data-testid={`list-reading-${kind}`}
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={drop}>
      <p className="flex items-center gap-1.5 text-sm font-medium"><Sparkles className="h-4 w-4 text-primary" /> Only have a paper list, photo, screenshot or PDF?</p>
      <p className="text-xs text-muted-foreground">
        Take a photo of the list (one page at a time), or upload a screenshot, scan, PDF or Word file. You can also paste a screenshot (Ctrl+V, or Cmd+V on a Mac). ComplyTrack reads the {noun} and fills in the rows for you to check. Nothing is saved until you import. The file is sent to Anthropic, our AI provider, to read; it isn't used to train their AI or kept by ComplyTrack.
        {readsLeft !== null && status.ai.active && ` ${readsLeft} of ${status.monthlyLimit} readings left this month.`}
      </p>
      {status.sites.length > 0 && kind !== "contractors" && kind !== "staff-roster" && (
        <label className="block text-xs">
          <span className="font-medium">Which site is this list for?</span>
          <select className="mt-1 flex h-9 w-full rounded-sm border border-input bg-background px-2 text-sm" value={reading.siteId}
            onChange={event => reading.setSiteId(event.target.value)} data-testid={`select-list-reading-site-${kind}`}>
            <option value="">More than one site, or not sure</option>
            {status.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </label>
      )}
      <input ref={input} type="file" accept={READABLE_LIST} className="hidden" data-testid={`input-list-reading-${kind}`}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) chosen(file); }} />
      <Button type="button" variant="outline" size="sm" disabled={!usable} onClick={() => input.current?.click()} data-testid={`button-list-reading-${kind}`}>
        <Camera className="mr-1 h-4 w-4" /> Choose or drag in a photo or document
      </Button>
      <div><AiAllowanceNote ai={status.ai} /></div>
    </div>
  );
}

/** After a reading: ask the person to check the rows, and offer them as a spreadsheet to correct. */
export function ListReadNote({ result, noun, one, kind, onDownload }: {
  result: ListReadResult; noun: string; one: string; kind: ListReadingKind; onDownload: () => void;
}) {
  const count = result.rows.length;
  const rowsText = result.unclearRows.length ? ` (row${result.unclearRows.length === 1 ? "" : "s"} ${result.unclearRows.join(", ")})` : "";
  const hasNotes = result.headers.some(header => header.toLowerCase() === "notes");
  return (
    <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" data-testid={`list-read-note-${kind}`}>
      <p>
        ComplyTrack read {count} {count === 1 ? one : noun} from your list. Check every row against the original before importing.
        {result.unclear > 0 && ` ${result.unclear} ${result.unclear === 1 ? "line was" : "lines were"} hard to read${rowsText}${hasNotes ? `; ${result.unclear === 1 ? "its" : "their"} notes start with "Check"` : ""}.`}
      </p>
      <p>To correct anything, download the rows as a spreadsheet, fix them and upload the spreadsheet instead.</p>
      <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onDownload} data-testid={`button-download-list-read-${kind}`}>
        <Download className="mr-1 h-3.5 w-3.5" /> Download as a spreadsheet
      </Button>
    </div>
  );
}
