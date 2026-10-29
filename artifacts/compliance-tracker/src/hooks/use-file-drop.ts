import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { toast } from "@/hooks/use-toast";
import { heicToJpeg, isHeic } from "@/lib/media-upload";

type DropZone = { enabled: boolean; deliver: (files: File[]) => void };

// Every mounted attach box, by the id in its data-file-drop-zone attribute, so
// a file dropped beside the box (not on it) can still reach it.
const zones = new Map<string, DropZone>();

const hasFiles = (transfer: DataTransfer | null) => Array.from(transfer?.types ?? []).includes("Files");

/**
 * The files in a drop. Safari sometimes leaves `files` empty but still offers
 * the file through `items`.
 */
function droppedFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []);
  if (files.length > 0) return files;
  return Array.from(transfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

// Dragging straight out of the Mac Photos app can hand Safari a link to the
// photo inside the Photos library instead of the photo itself, and a web page
// is not allowed to open that link.
function explainUnreadableDrop() {
  toast({
    title: "The browser didn't pass the photo on",
    description: "Drag the photo out of Photos onto your desktop first, then drag it in from there, or use Choose files.",
    variant: "destructive",
  });
}

/**
 * Drag-and-drop for an attach box: spread `dropZoneProps` on the element that
 * should accept files, and show a highlight while `isDragging`. Dropped files
 * go to `onFiles` exactly as if they had been picked, so the box's own type and
 * size checks still apply. HEIC photos (the Mac Photos app's usual format) are
 * turned into JPEG first where the browser can read them. Nothing happens while
 * `enabled` is false.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave also fire for child elements; count them so the
  // highlight only clears when the pointer leaves the box itself.
  const depth = useRef(0);
  const id = useId();
  const latest = useRef({ onFiles, enabled });
  latest.current = { onFiles, enabled };

  useEffect(() => {
    zones.set(id, {
      get enabled() { return latest.current.enabled; },
      deliver(files) {
        if (!files.some(isHeic)) {
          latest.current.onFiles(files);
          return;
        }
        void Promise.all(files.map(heicToJpeg)).then((ready) => latest.current.onFiles(ready));
      },
    });
    return () => { zones.delete(id); };
  }, [id]);

  const dropZoneProps = {
    "data-file-drop-zone": id,
    onDragEnter(event: DragEvent) {
      if (!enabled || !hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      setIsDragging(true);
    },
    onDragOver(event: DragEvent) {
      if (!enabled || !hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      // Only ask for "copy" when the source allows it: Safari can treat a
      // drop effect the source doesn't offer as "not handled" and open the
      // file itself instead.
      if (/^(all|uninitialized|copy\w*)$/i.test(event.dataTransfer.effectAllowed)) event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(event: DragEvent) {
      if (!enabled || !hasFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setIsDragging(false);
    },
    onDrop(event: DragEvent) {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0;
      setIsDragging(false);
      if (!enabled) return;
      const files = droppedFiles(event.dataTransfer);
      if (files.length > 0) zones.get(id)?.deliver(files);
      else explainUnreadableDrop();
    },
  };

  return { isDragging, dropZoneProps };
}

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, [contenteditable='true']"));
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
  let draggingFromPage = false;
  window.addEventListener("dragstart", () => { draggingFromPage = true; }, true);
  window.addEventListener("dragend", () => { draggingFromPage = false; }, true);

  const fromOutside = (event: globalThis.DragEvent) => {
    if (draggingFromPage) return false;
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (types.includes("Files")) return true;
    // A dragged link (or a Photos library file link): leave text boxes alone
    // so a link can still be dropped into one.
    return types.includes("text/uri-list") && !isEditable(event.target);
  };

  window.addEventListener("dragover", (event) => {
    if (!event.defaultPrevented && fromOutside(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    draggingFromPage = false;
    if (event.defaultPrevented || !fromOutside(event)) return;
    event.preventDefault();
    const files = droppedFiles(event.dataTransfer);
    if (files.length === 0) {
      const link = event.dataTransfer?.getData("text/uri-list") ?? "";
      if (hasFiles(event.dataTransfer) || /^file:/i.test(link.trim())) explainUnreadableDrop();
      return;
    }
    const underPointer = event.target instanceof Element
      ? zones.get(event.target.closest<HTMLElement>("[data-file-drop-zone]")?.dataset.fileDropZone ?? "")
      : undefined;
    const targets = underPointer?.enabled ? [underPointer] : visibleZones();
    if (targets.length === 1) {
      targets[0]!.deliver(files);
      return;
    }
    toast({
      title: "Drop it on an upload box",
      description: targets.length === 0
        ? "This page doesn't take files. Open the record first, then drag the file onto its photos or upload box."
        : "Drag the file onto the photos or upload box you want it in.",
    });
  });
}
