import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PAGES = 100;
const MAX_IMAGE_PIXELS = 16_000_000;

async function validate() {
  const { bytes, testMode } = workerData as { bytes: Uint8Array; testMode?: "timeout" | "oom" };
  if (testMode === "timeout") await new Promise(() => {});
  if (testMode === "oom") {
    const allocations: number[][] = [];
    while (true) allocations.push(new Array(1_000_000).fill(1));
  }

  const input = new Uint8Array(bytes);
  const tail = Buffer.from(input.subarray(Math.max(0, input.length - 4096))).toString("latin1");
  const eofAt = tail.lastIndexOf("%%EOF");
  if (eofAt < 0 || !/^[\x09\x0a\x0c\x0d\x20]*$/.test(tail.slice(eofAt + 5))) {
    throw new Error("PDF has trailing or missing data");
  }

  // Reject explicit oversized image dictionaries even if PDF.js elects not to
  // decode/render that image due to maxImageSize.
  const source = Buffer.from(input).toString("latin1");
  for (const match of source.matchAll(/\/Width\s+(\d+)[\s\S]{0,256}?\/Height\s+(\d+)/g)) {
    if (Number(match[1]) * Number(match[2]) > MAX_IMAGE_PIXELS) throw new Error("PDF image resource is too large");
  }

  const task = getDocument({
    data: input,
    stopAtErrors: true,
    maxImageSize: MAX_IMAGE_PIXELS,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
  } as Parameters<typeof getDocument>[0] & { isEvalSupported: boolean });
  const document = await task.promise;
  try {
    if (document.numPages < 1 || document.numPages > MAX_PAGES) throw new Error("PDF page count is invalid");
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      if (!(viewport.width > 0) || !(viewport.height > 0)) throw new Error("PDF page is invalid");
      // Catalog/page-tree access for every page is lightweight. Decode content
      // only on the first page, inside this memory/time-bounded worker, to make
      // malformed compressed streams observable without rendering all pages.
      if (pageNumber === 1) await page.getOperatorList();
      page.cleanup();
    }
  } finally {
    document.cleanup();
    await task.destroy();
  }
}

validate()
  .then(() => parentPort?.postMessage({ ok: true }))
  .catch((error) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : "PDF validation failed" }));