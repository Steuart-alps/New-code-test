import { useRef, useState, type DragEvent } from "react";

/**
 * Drag-and-drop for an attach box: spread `dropZoneProps` on the element that
 * should accept files, and show a highlight while `isDragging`. Dropped files
 * go to `onFiles` exactly as if they had been picked, so the box's own type and
 * size checks still apply. Nothing happens while `enabled` is false.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave also fire for child elements; count them so the
  // highlight only clears when the pointer leaves the box itself.
  const depth = useRef(0);
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const dropZoneProps = {
    onDragEnter(event: DragEvent) {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setIsDragging(true);
    },
    onDragOver(event: DragEvent) {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(event: DragEvent) {
      if (!enabled || !hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setIsDragging(false);
    },
    onDrop(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setIsDragging(false);
      if (!enabled) return;
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) onFiles(files);
    },
  };

  return { isDragging, dropZoneProps };
}
