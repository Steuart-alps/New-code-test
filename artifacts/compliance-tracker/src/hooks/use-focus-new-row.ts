import { useCallback, useLayoutEffect, useRef } from "react";

const FIELDS = "input, textarea, select, button[role=combobox]";
const TYPING_INPUTS = new Set(["text", "search", "number", "email", "tel", "url", "password"]);

function canTakeCursor(field: HTMLElement): boolean {
  // Hidden helper boxes (Radix keeps a hidden native select for forms) are skipped.
  if ((field as HTMLInputElement).disabled || field.tabIndex < 0 || field.getAttribute("aria-hidden") === "true") return false;
  return !(field instanceof HTMLInputElement) || !["checkbox", "radio", "hidden", "file"].includes(field.type);
}

function isEmpty(field: HTMLElement): boolean {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) return field.value === "";
  // Radix Select marks its trigger while it shows the placeholder.
  return field.hasAttribute("data-placeholder");
}

/** A box that brings up the phone keyboard; date pickers and drop-downs do not. */
function isTypingBox(field: HTMLElement): boolean {
  return field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && TYPING_INPUTS.has(field.type));
}

/**
 * Puts the cursor in a row the user has just added to a list ("Add item",
 * "Add appliance", ...), so they can type straight away. Put `ref` on an
 * element around the list and call `expect()` in the add button's click
 * handler; after the render that adds the row, the first empty box among the
 * boxes that were not there before is focused (the first new box if none is
 * empty, e.g. a scanned unit name). Boxes that appear any other way, such as a
 * list loading, are left alone.
 *
 * On phones only typing boxes are focused: tapping "Add" is when the user
 * wants the keyboard, but opening a date wheel or drop-down by itself is not.
 */
export function useFocusNewRow<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const before = useRef<Set<Element> | null>(null);

  const expect = useCallback(() => {
    const snapshot = new Set(ref.current?.querySelectorAll(FIELDS) ?? []);
    before.current = snapshot;
    // Nothing was added (a limit was reached, say): forget it, so a later
    // reload of the list does not steal the cursor.
    window.setTimeout(() => { if (before.current === snapshot) before.current = null; }, 1000);
  }, []);

  useLayoutEffect(() => {
    const seen = before.current;
    if (!seen || !ref.current) return;
    const added = Array.from(ref.current.querySelectorAll<HTMLElement>(FIELDS)).filter(field => !seen.has(field) && canTakeCursor(field));
    if (added.length === 0) return;
    before.current = null;
    const field = added.find(isEmpty) ?? added[0];
    if (window.matchMedia?.("(pointer: coarse)").matches && !isTypingBox(field)) return;
    field.focus();
  });

  return { ref, expect };
}
