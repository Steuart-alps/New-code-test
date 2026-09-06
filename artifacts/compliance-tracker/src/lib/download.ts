/**
 * Downloads a file without opening a new browser tab. Fetching into a Blob also
 * makes this work for signed inspection-document URLs when pop-ups are blocked.
 */
export async function downloadFile(url: string, filename: string): Promise<void> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  try {
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Let the browser start consuming the object URL before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

/**
 * Opens the browser print dialog from a same-tab, temporary document. This
 * avoids the pop-up window that browsers commonly block for PDF exports.
 */
export function printHtmlDocument(html: string): void {
  const objectUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    frame.remove();
    URL.revokeObjectURL(objectUrl);
  };

  frame.onload = () => {
    const printWindow = frame.contentWindow;
    if (!printWindow) {
      cleanup();
      return;
    }
    printWindow.addEventListener("afterprint", cleanup, { once: true });
    printWindow.focus();
    printWindow.print();
    // Some browsers do not dispatch afterprint when the dialog is cancelled.
    window.setTimeout(cleanup, 60_000);
  };
  frame.onerror = cleanup;
  frame.src = objectUrl;
  document.body.appendChild(frame);
}