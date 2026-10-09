import type { jsPDF as JsPdf } from "jspdf";
// Only the asset URLs are in the page bundle; the font bytes are fetched
// alongside the lazily loaded PDF modules when an export starts.
import notoSansRegularUrl from "@/assets/fonts/NotoSans-Regular.ttf?url";
import notoSansBoldUrl from "@/assets/fonts/NotoSans-Bold.ttf?url";

/** An export failure whose message tells the user how to recover. */
export class HotTubLogPdfError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HotTubLogPdfError";
  }
}

// Browsers keep a failed dynamic import for the page's lifetime, so retrying
// in place cannot succeed; only a reload fetches the module again.
const MODULE_LOAD_FAILED = "The PDF tool could not be loaded. Reload the page, then try again.";
const GENERATION_FAILED = "The PDF could not be created. Please try again.";

// Noto Sans (SIL OFL 1.1), subset to Latin, Latin Extended, Greek, Cyrillic
// and common symbols; see src/assets/fonts/OFL.txt and
// scripts/subset-pdf-fonts.sh.
const FONT = "NotoSans";
const FONT_FILES = [
  { url: notoSansRegularUrl, file: "NotoSans-Regular.ttf", style: "normal" },
  { url: notoSansBoldUrl, file: "NotoSans-Bold.ttf", style: "bold" },
] as const;

/**
 * jsPDF's output() catches its own errors, shows a native alert and returns
 * undefined. Silence the alert for this synchronous call and report the
 * failure in the page instead.
 */
function outputBlob(pdf: JsPdf): Blob {
  const nativeAlert = window.alert;
  window.alert = () => {};
  try {
    const blob: unknown = pdf.output("blob");
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error("jsPDF produced no PDF data");
    return blob;
  } finally {
    window.alert = nativeAlert;
  }
}

// A failed fetch is not cached, so forget it and fetch again on the next try.
let fontData: Promise<string[]> | null = null;

function loadFonts(): Promise<string[]> {
  fontData ??= Promise.all(FONT_FILES.map(async ({ url }) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Font request failed with HTTP ${response.status}`);
    // jsPDF's virtual file system takes TrueType data as a binary string.
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return binary;
  }));
  fontData.catch(() => { fontData = null; });
  return fontData;
}

export interface HotTubLogPdfReport {
  generatedAt: Date;
  generatedBy: string;
  filters: string[];
  rows: string[][];
}

/** Generate text-based, paginated PDF bytes without a print window or dialog. */
export async function createHotTubLogPdf(report: HotTubLogPdfReport): Promise<Blob> {
  // Keep PDF libraries and fonts out of the initial page bundle.
  let modules: [typeof import("jspdf"), typeof import("jspdf-autotable"), string[]];
  try {
    modules = await Promise.all([import("jspdf"), import("jspdf-autotable"), loadFonts()]);
  } catch (cause) {
    throw new HotTubLogPdfError(MODULE_LOAD_FAILED, { cause });
  }
  try {
    return buildPdf(modules[0].jsPDF, modules[1].autoTable, modules[2], report);
  } catch (cause) {
    if (cause instanceof HotTubLogPdfError) throw cause;
    throw new HotTubLogPdfError(GENERATION_FAILED, { cause });
  }
}

/**
 * Normalise text so equivalent input renders and extracts consistently:
 * composed accents (NFC), plain spaces instead of no-break variants (which
 * share the space glyph and would otherwise change how every space is
 * extracted), and no invisible control or zero-width characters.
 */
export function normalisePdfText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\t\u00a0\u2007\u202f]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/g, "");
}

const MAX_LISTED_CHARACTERS = 8;

function describeCharacter(char: string): string {
  const code = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
  return `"${char}" (U+${code})`;
}

/**
 * jsPDF silently drops characters the embedded font has no glyph for, so
 * refuse to build a report that would lose text. The message names only the
 * characters, never the record text around them.
 */
function assertRenderable(texts: string[], codeMaps: Array<Record<number, number>>): void {
  const missing = new Set<string>();
  for (const text of texts) {
    for (const char of text) {
      if (char === "\n" || char === " ") continue;
      const code = char.codePointAt(0)!;
      // jsPDF encodes UTF-16 code units, so it cannot use glyphs beyond the BMP.
      if (code > 0xffff || codeMaps.some(codeMap => !codeMap[code])) missing.add(char);
    }
  }
  if (missing.size === 0) return;
  const listed = [...missing].slice(0, MAX_LISTED_CHARACTERS).map(describeCharacter).join(", ");
  const more = missing.size > MAX_LISTED_CHARACTERS
    ? ` and ${missing.size - MAX_LISTED_CHARACTERS} more`
    : "";
  throw new HotTubLogPdfError(
    `The PDF font cannot show ${missing.size === 1 ? "this character" : "these characters"}: ${listed}${more}. ` +
      "Change the search or filters to leave out the records that contain them, or edit those records, then try again.",
  );
}

type FontMetadata = { metadata: { cmap: { unicode: { codeMap: Record<number, number> } } } };

function buildPdf(
  jsPDF: typeof import("jspdf").jsPDF,
  autoTable: typeof import("jspdf-autotable").autoTable,
  fonts: string[],
  report: HotTubLogPdfReport,
): Blob {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  FONT_FILES.forEach(({ file, style }, index) => {
    pdf.addFileToVFS(file, fonts[index]);
    pdf.addFont(file, FONT, style, undefined, "Identity-H");
  });
  const codeMaps = FONT_FILES.map(({ style }) => {
    pdf.setFont(FONT, style);
    return (pdf.getFont() as unknown as FontMetadata).metadata.cmap.unicode.codeMap;
  });

  const title = "Hot Tub & Spa Maintenance Log";
  const date = report.generatedAt.toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
  const generatedBy = normalisePdfText(report.generatedBy);
  const metadata = [
    `${generatedBy || "ComplyTrack"} - generated ${date} - for health inspection`,
    ...(report.filters.length ? report.filters.map(normalisePdfText) : ["All records"]),
    `Records: ${report.rows.length}`,
  ];
  const head = [
    "Date", "Session", "Site", "Tub", "Check", "Result", "pH",
    "Sanitiser (ppm)", "Temp (°C)", "Location", "Performed by", "Notes",
  ];
  const emptyMessage = "No records match the current filter.";
  const rows = report.rows.map(row => row.map(normalisePdfText));
  const pageCountText = "Page 0123456789 of";
  assertRenderable([title, ...metadata, ...head, emptyMessage, pageCountText, ...rows.flat()], codeMaps);

  pdf.setProperties({ title, author: generatedBy, creator: "ComplyTrack" });
  pdf.setCreationDate(report.generatedAt);
  const margins = { top: 25, bottom: 15, left: 10, right: 10 };
  const drawTitle = () => {
    pdf.setFont(FONT, "bold");
    pdf.setFontSize(15);
    pdf.setTextColor(26, 45, 62);
    pdf.text(title, 10, 14);
  };
  // A table also paginates unusually long filter/search descriptions safely.
  autoTable(pdf, {
    startY: 25,
    margin: margins,
    theme: "plain",
    styles: { font: FONT, fontStyle: "normal", fontSize: 9, cellPadding: 1, overflow: "linebreak" },
    body: metadata.map(line => [line]),
    rowPageBreak: "avoid",
    didDrawPage: drawTitle,
  });
  const metadataEnd = (pdf as typeof pdf & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  autoTable(pdf, {
    startY: metadataEnd + 5,
    margin: margins,
    theme: "grid",
    head: [head],
    // No italic face is embedded; grey text marks the empty state instead.
    body: rows.length ? rows : [[{
      content: emptyMessage, colSpan: 12,
      styles: { textColor: [100, 100, 100] },
    }]],
    showHead: "everyPage",
    rowPageBreak: "avoid",
    styles: {
      font: FONT, fontStyle: "normal", fontSize: 7.5, cellPadding: 1.5,
      overflow: "linebreak", valign: "top", lineColor: [200, 205, 210], lineWidth: 0.15,
    },
    headStyles: { font: FONT, fillColor: [26, 45, 62], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [247, 248, 249] },
    columnStyles: {
      0: { cellWidth: 18 }, 1: { cellWidth: 14 }, 2: { cellWidth: 22 },
      3: { cellWidth: 22 }, 4: { cellWidth: 34 }, 5: { cellWidth: 11 },
      6: { cellWidth: 9 }, 7: { cellWidth: 17 }, 8: { cellWidth: 13 },
      9: { cellWidth: 21 }, 10: { cellWidth: 21 }, 11: { cellWidth: 75 },
    },
    didDrawPage: drawTitle,
  });
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFont(FONT, "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(100);
    pdf.text(`Page ${page} of ${pages}`, pdf.internal.pageSize.getWidth() - 10,
      pdf.internal.pageSize.getHeight() - 7, { align: "right" });
  }
  return outputBlob(pdf);
}
