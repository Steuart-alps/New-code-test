import PDFDocument from "pdfkit";

export type CleaningScheduleCompletion = {
  taskArea?: string;
  taskName: string;
  done: boolean;
  doneBy?: string;
  notes?: string;
};

export type CleaningScheduleLog = {
  date: string;
  frequency: string;
  siteName: string | null;
  completions: CleaningScheduleCompletion[];
  signedBy: string;
  submittedAt: Date | null;
};

export type CleaningScheduleRegister = {
  businessName: string;
  /** The site the export is limited to, or null for every site. */
  siteName: string | null;
  dateFrom: string;
  dateTo: string;
  frequency: string;
  generatedAt: string;
  logs: CleaningScheduleLog[];
};

const REGULAR_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function value(value: string | undefined): string {
  return value?.trim() || "Not recorded";
}

function formatDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function ensureSpace(doc: PDFKit.PDFDocument, height = 50): void {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

export async function createCleaningSchedulePdf(register: CleaningScheduleRegister): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 36, right: 32, bottom: 36, left: 32 },
    font: REGULAR_FONT,
    info: {
      Title: "Cleaning Schedule Completion Record",
      Author: register.businessName,
      Subject: "Food hygiene inspection cleaning schedule evidence",
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font(BOLD_FONT).fontSize(18).fillColor("#111827").text("Cleaning Schedule Completion Record");
  doc.font(BOLD_FONT).fontSize(13).text(`Business: ${value(register.businessName)}`);
  doc.font(BOLD_FONT).fontSize(13)
    .text(`Site: ${register.siteName === null ? "All sites" : value(register.siteName)}`);
  doc.font(REGULAR_FONT).fontSize(8).fillColor("#4b5563")
    .text(`${register.frequency} logs · ${formatDate(register.dateFrom)} to ${formatDate(register.dateTo)}`)
    .text(`Generated: ${register.generatedAt} · Prepared for food hygiene inspections`);
  doc.moveDown(0.8);

  if (register.logs.length === 0) {
    doc.font(REGULAR_FONT).fontSize(10).fillColor("#111827")
      .text(
        register.siteName === null
          ? "No cleaning logs were recorded for the selected date range and frequency."
          : "No cleaning logs were recorded for this site in the selected date range and frequency.",
      );
  }

  for (const [index, log] of register.logs.entries()) {
    ensureSpace(doc, 85);
    const completed = log.completions.filter((item) => item.done).length;
    doc.font(BOLD_FONT).fontSize(11).fillColor("#111827")
      .text(`${index + 1}. ${formatDate(log.date)} — ${completed}/${log.completions.length} tasks completed`);
    if (register.siteName === null) {
      doc.font(REGULAR_FONT).fontSize(8).fillColor("#374151")
        .text(`Site: ${log.siteName ?? "No site recorded"}`);
    }
    doc.font(REGULAR_FONT).fontSize(8).fillColor("#374151")
      .text(
        log.submittedAt
          ? `Signed off by ${value(log.signedBy)} on ${log.submittedAt.toLocaleString("en-GB")}`
          : `Draft — sign-off: ${value(log.signedBy)}`,
      );
    doc.moveDown(0.35);

    for (const item of log.completions) {
      ensureSpace(doc, 38);
      doc.font(BOLD_FONT).fontSize(8).fillColor(item.done ? "#166534" : "#991b1b")
        .text(`${item.done ? "DONE" : "NOT DONE"}  ${value(item.taskArea)} — ${value(item.taskName)}`);
      doc.font(REGULAR_FONT).fillColor("#374151")
        .text(`Done by: ${item.done ? value(item.doneBy) : "Not applicable"} · Notes: ${value(item.notes)}`);
      doc.moveDown(0.3);
    }
    doc.moveDown(0.7);
    doc.strokeColor("#d1d5db").moveTo(doc.page.margins.left, doc.y).lineTo(810, doc.y).stroke();
    doc.moveDown(0.7);
  }

  doc.end();
  return complete;
}