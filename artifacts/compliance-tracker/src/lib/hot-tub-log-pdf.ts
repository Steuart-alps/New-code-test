import type { jsPDF as JsPdf } from "jspdf";

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

export interface HotTubLogPdfReport {
  generatedAt: Date;
  generatedBy: string;
  filters: string[];
  rows: string[][];
}

/** Generate text-based, paginated PDF bytes without a print window or dialog. */
export async function createHotTubLogPdf(report: HotTubLogPdfReport): Promise<Blob> {
  // Keep PDF libraries out of the initial page bundle.
  let modules: [typeof import("jspdf"), typeof import("jspdf-autotable")];
  try {
    modules = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  } catch (cause) {
    throw new HotTubLogPdfError(MODULE_LOAD_FAILED, { cause });
  }
  try {
    return buildPdf(modules[0].jsPDF, modules[1].autoTable, report);
  } catch (cause) {
    throw new HotTubLogPdfError(GENERATION_FAILED, { cause });
  }
}

function buildPdf(
  jsPDF: typeof import("jspdf").jsPDF,
  autoTable: typeof import("jspdf-autotable").autoTable,
  report: HotTubLogPdfReport,
): Blob {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  const title = "Hot Tub & Spa Maintenance Log";
  const date = report.generatedAt.toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
  pdf.setProperties({ title, author: report.generatedBy, creator: "ComplyTrack" });
  pdf.setCreationDate(report.generatedAt);
  const margins = { top: 25, bottom: 15, left: 10, right: 10 };
  const drawTitle = () => {
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(15);
    pdf.setTextColor(26, 45, 62);
    pdf.text(title, 10, 14);
  };
  // A table also paginates unusually long filter/search descriptions safely.
  autoTable(pdf, {
    startY: 25,
    margin: margins,
    theme: "plain",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 1, overflow: "linebreak" },
    body: [
      [`${report.generatedBy || "ComplyTrack"} - generated ${date} - for health inspection`],
      ...(report.filters.length ? report.filters : ["All records"]).map(filter => [filter]),
      [`Records: ${report.rows.length}`],
    ],
    rowPageBreak: "avoid",
    didDrawPage: drawTitle,
  });
  const metadataEnd = (pdf as typeof pdf & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  autoTable(pdf, {
    startY: metadataEnd + 5,
    margin: margins,
    theme: "grid",
    head: [[
      "Date", "Session", "Site", "Tub", "Check", "Result", "pH",
      "Sanitiser (ppm)", "Temp (°C)", "Location", "Performed by", "Notes",
    ]],
    body: report.rows.length ? report.rows : [[{
      content: "No records match the current filter.", colSpan: 12,
      styles: { fontStyle: "italic" },
    }]],
    showHead: "everyPage",
    rowPageBreak: "avoid",
    styles: {
      font: "helvetica", fontSize: 7.5, cellPadding: 1.5,
      overflow: "linebreak", valign: "top", lineColor: [200, 205, 210], lineWidth: 0.15,
    },
    headStyles: { fillColor: [26, 45, 62], textColor: 255, fontStyle: "bold" },
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
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(100);
    pdf.text(`Page ${page} of ${pages}`, pdf.internal.pageSize.getWidth() - 10,
      pdf.internal.pageSize.getHeight() - 7, { align: "right" });
  }
  return outputBlob(pdf);
}