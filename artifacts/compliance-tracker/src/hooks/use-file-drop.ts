import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { toast } from "@/hooks/use-toast";
import { heicToJpeg, isHeic } from "@/lib/media-upload";

type DropZone = {
  enabled: boolean;
  /** Which files a drop beside the box may send to it (all, when left out). */
  accepts?: (file: File) => boolean;
  deliver: (files: File[]) => void;
};

const takesAll = (zone: DropZone, files: File[]) => !zone.accepts || files.every((file) => zone.accepts!(file));

// Every mounted attach box, by the id in its data-file-drop-zone attribute, so
// a file dropped beside the box (not on it) can still reach it.
const zones = new Map<string, DropZone>();

const hasFiles = (transfer: DataTransfer | null) => Array.from(transfer?.types ?? []).includes("Files");

// Set while something dragged from inside the app (selected text, a link, an
// image) is on the move, so only drags from outside are treated as uploads.
// installStrayFileDropGuard keeps it up to date.
let draggingFromPage = false;

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);

/** A box that takes typed text, where a dropped link or text belongs. */
function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest("textarea, [contenteditable='true']")) return true;
  const input = target.closest("input");
  return !!input && TEXT_INPUT_TYPES.has(input.type);
}

/**
 * Whether a drag over an attach box may be an upload. Besides real files,
 * this takes anything dragged in from outside the app (not onto a text box):
 * email apps such as Mail and Outlook often hand the browser a link or a
 * "promised" file rather than the file itself, and without this the box
 * ignores the drag and nothing at all happens.
 */
function mayBeUpload(event: { dataTransfer: DataTransfer | null; target: EventTarget | null }) {
  if (hasFiles(event.dataTransfer)) return true;
  return !draggingFromPage && (event.dataTransfer?.types.length ?? 0) > 0 && !isEditable(event.target);
}

/**
 * Everything a drop offers, copied while the drop event runs (the browser
 * empties the drag data as soon as the event is over).
 */
type DropContents = {
  files: File[];
  entries: FileSystemFileEntry[];
  html: string;
  links: string[];
  /** The drag said it carried files (types included "Files"). */
  saidFiles: boolean;
};

function dropContents(transfer: DataTransfer | null): DropContents {
  const empty: DropContents = { files: [], entries: [], html: "", links: [], saidFiles: false };
  if (!transfer) return empty;
  const read = (type: string) => { try { return transfer.getData(type) ?? ""; } catch { return ""; } };
  const items = Array.from(transfer.items ?? []);
  // Safari sometimes leaves `files` empty but still offers the file through `items`.
  let files = Array.from(transfer.files ?? []);
  if (files.length === 0) {
    files = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  }
  const entries: FileSystemFileEntry[] = [];
  if (files.length === 0) {
    for (const item of items) {
      if (item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") continue;
      const entry = item.webkitGetAsEntry();
      if (entry?.isFile) entries.push(entry as FileSystemFileEntry);
    }
  }
  const links = read("text/uri-list").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  return { files, entries, html: read("text/html"), links, saidFiles: hasFiles(transfer) };
}

const MAX_EMBEDDED = 10;

/** blob: and data: addresses an email app put in a drop's HTML or links (Mail does this for attachments it shows inline). */
function embeddedAddresses(contents: DropContents): Array<{ url: string; name: string }> {
  const found: Array<{ url: string; name: string }> = [];
  const add = (url: string, name = "") => {
    if (/^(blob|data):/i.test(url) && !found.some((f) => f.url === url)) found.push({ url, name });
  };
  if (contents.html) {
    try {
      const doc = new DOMParser().parseFromString(contents.html, "text/html");
      doc.querySelectorAll<HTMLElement>("[src], [href]").forEach((element) => {
        const url = element.getAttribute("src") ?? element.getAttribute("href") ?? "";
        add(url, element.getAttribute("download") || element.getAttribute("alt") || element.getAttribute("title") || "");
      });
    } catch { /* not readable HTML */ }
  }
  contents.links.forEach((link) => add(link));
  return found.slice(0, MAX_EMBEDDED);
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif",
  "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov",
};

async function fileFromAddress({ url, name }: { url: string; name: string }, index: number): Promise<File | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size === 0) return null;
    const type = blob.type.split(";")[0]!.trim();
    const cleanName = name.trim().replace(/[\\/:*?"<>|]+/g, "_");
    const fileName = /\.[a-z0-9]{2,5}$/i.test(cleanName)
      ? cleanName
      : `${cleanName || `attachment-${index + 1}`}.${EXTENSIONS[type] ?? "bin"}`;
    return new File([blob], fileName, { type });
  } catch {
    // The email app's own address, which a web page is not allowed to open.
    return null;
  }
}

/**
 * The files in a drop: real files first, then files the browser only offers
 * as a file entry, then attachments an email app embedded in the drop's HTML
 * (blob: and data: addresses), where the browser lets the page read them.
 */
async function filesFrom(contents: DropContents): Promise<File[]> {
  if (contents.files.length > 0) return contents.files;
  if (contents.entries.length > 0) {
    const fromEntries = await Promise.all(contents.entries.map((entry) =>
      new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)))));
    const usable = fromEntries.filter((file): file is File => file !== null);
    if (usable.length > 0) return usable;
  }
  const embedded = await Promise.all(embeddedAddresses(contents).map(fileFromAddress));
  return embedded.filter((file): file is File => file !== null);
}

/**
 * Says why a drop brought no file, when the drop looked like one: Mail,
 * Outlook and the Photos app often hand the browser a "promised" file, or a
 * link to it, that a web page is not allowed to open. Anything else (a web
 * link, some text) is left without a message.
 */
function explainEmptyDrop(contents: DropContents) {
  const link = contents.links[0] ?? "";
  if (contents.saidFiles || /^(file|message|blob):/i.test(link) || /\b(src|href)\s*=\s*["']?(blob|file|cid):/i.test(contents.html)) {
    explainUnreadableDrop();
    return true;
  }
  if (/^https?:/i.test(link)) {
    toast({
      title: "That's a link, not a file",
      description: "Webmail (such as Outlook or Gmail in the browser) passes on a link to the attachment, not the attachment itself. Download the attachment first, then drag it in from your Downloads folder, or use Choose files.",
      variant: "destructive",
      stay: true,
    });
    return true;
  }
  return false;
}

// Dragging straight out of an email (Mail or Outlook) or the Mac Photos app
// can hand the browser a link to the file, or a file promised for later,
// instead of the file itself, and a web page is not allowed to open those.
function explainUnreadableDrop() {
  toast({
    title: "The file didn't come through",
    description: "Mail, Outlook and Photos don't always hand the file itself to the browser. Drag the attachment or photo onto your desktop first (or save it), then drag it in from there, or use Choose files.",
    variant: "destructive",
    stay: true,
  });
}

/**
 * Whether the browser can actually read a dropped file. Safari can hand over a
 * photo dragged out of the Photos library that it isn't then allowed to read,
 * which otherwise fails later as an unexplained upload error.
 */
async function canRead(file: File) {
  if (file.size === 0) return false;
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * Drag-and-drop for an attach box: spread `dropZoneProps` on the element that
 * should accept files, and show a highlight while `isDragging`. Dropped files
 * go to `onFiles` exactly as if they had been picked, so the box's own type and
 * size checks still apply. HEIC photos (the Mac Photos app's usual format) are
 * turned into JPEG first where the browser can read them. Nothing happens while
 * `enabled` is false. With `accepts`, a file dropped beside the box (not on
 * it) only goes to the box when it is a file the box takes, such as a
 * spreadsheet for an Import spreadsheet button.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true, accepts?: (file: File) => boolean) {
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave also fire for child elements; count them so the
  // highlight only clears when the pointer leaves the box itself.
  const depth = useRef(0);
  const id = useId();
  const latest = useRef({ onFiles, enabled, accepts });
  latest.current = { onFiles, enabled, accepts };

  useEffect(() => {
    zones.set(id, {
      get enabled() { return latest.current.enabled; },
      get accepts() { return latest.current.accepts; },
      deliver(files) {
        void Promise.all(files.map(async (file) => (await canRead(file)) ? heicToJpeg(file) : null)).then((ready) => {
          const usable = ready.filter((file): file is File => file !== null);
          if (usable.length < files.length) explainUnreadableDrop();
          if (usable.length > 0) latest.current.onFiles(usable);
        });
      },
    });
    return () => { zones.delete(id); };
  }, [id]);

  const dropZoneProps = {
    "data-file-drop-zone": id,
    onDragEnter(event: DragEvent) {
      if (!enabled || !mayBeUpload(event)) return;
      event.preventDefault();
      depth.current += 1;
      setIsDragging(true);
    },
    onDragOver(event: DragEvent) {
      if (!enabled || !mayBeUpload(event)) return;
      event.preventDefault();
      // Only ask for "copy" when the source allows it: Safari can treat a
      // drop effect the source doesn't offer as "not handled" and open the
      // file itself instead.
      if (/^(all|uninitialized|copy\w*)$/i.test(event.dataTransfer.effectAllowed)) event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(event: DragEvent) {
      if (!enabled || !mayBeUpload(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setIsDragging(false);
    },
    onDrop(event: DragEvent) {
      if (!mayBeUpload(event)) return;
      event.preventDefault();
      draggingFromPage = false;
      depth.current = 0;
      setIsDragging(false);
      if (!enabled) return;
      const contents = dropContents(event.dataTransfer);
      void filesFrom(contents).then((files) => {
        if (files.length > 0) zones.get(id)?.deliver(files);
        else if (!explainEmptyDrop(contents)) explainUnreadableDrop();
      });
    },
  };

  return { isDragging, dropZoneProps };
}

// A box someone can see: not hidden, and not behind an open dialog (dialogs
// mark the rest of the page aria-hidden).
function visibleZones(): DropZone[] {
  const found: DropZone[] = [];
  document.querySelectorAll<HTMLElement>("[data-file-drop-zone]").forEach((element) => {
    const zone = zones.get(element.dataset.fileDropZone ?? "");
    if (!zone?.enabled || element.getClientRects().length === 0) return;
    if (element.closest("[aria-hidden='true'], [inert]")) return;
    found.push(zone);
  });
  return found;
}

/**
 * Stops the browser from leaving the app to open a file that is dropped
 * anywhere other than an attach box (Safari shows a "file:///…" error page and
 * anything typed into the form is lost). If the page has exactly one attach box
 * in view, such as the photos box in an open FixTrack form, the file goes to
 * that box; otherwise a message says where to drop it.
 */
export function installStrayFileDropGuard() {
  // Drags that start inside the app (selected text, links, images) are left
  // to behave as normal.
  window.addEventListener("dragstart", () => { draggingFromPage = true; }, true);
  window.addEventListener("dragend", () => { draggingFromPage = false; }, true);

  const fromOutside = (event: globalThis.DragEvent) => {
    if (draggingFromPage) return false;
    if (hasFiles(event.dataTransfer)) return true;
    // Anything else dragged in from outside (a link, a Photos library file
    // link, an email attachment, or a type Safari doesn't name): text boxes
    // still take it as text, everywhere else the page holds it rather than
    // the browser opening it.
    return !isEditable(event.target);
  };

  window.addEventListener("dragover", (event) => {
    if (!event.defaultPrevented && fromOutside(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (event.defaultPrevented || !fromOutside(event)) { draggingFromPage = false; return; }
    draggingFromPage = false;
    event.preventDefault();
    const contents = dropContents(event.dataTransfer);
    const underPointer = event.target instanceof Element
      ? zones.get(event.target.closest<HTMLElement>("[data-file-drop-zone]")?.dataset.fileDropZone ?? "")
      : undefined;
    void filesFrom(contents).then((files) => {
      if (files.length === 0) {
        explainEmptyDrop(contents);
        return;
      }
      const targets = underPointer?.enabled && takesAll(underPointer, files)
        ? [underPointer]
        : visibleZones().filter((zone) => takesAll(zone, files));
      if (targets.length === 1) {
        targets[0]!.deliver(files);
        return;
      }
      toast({
        stay: true,
        title: "Drop it on an upload box",
        description: targets.length === 0
          ? "This page doesn't take files. Open the record first, then drag the file onto its photos or upload box."
          : "Drag the file onto the photos or upload box you want it in.",
      });
    });
  });
}
