import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { PDF_BOLD_FONT, PDF_REGULAR_FONT } from "./pdfFonts";

/**
 * A sheet of QR labels sized for the common A4 label sheets:
 *   standard: 63.5 x 38.1 mm, 3 x 7 = 21 per sheet (L7160 layout)
 *   large:    99.1 x 67.7 mm, 2 x 4 = 8 per sheet (L7165 layout), for
 *             weatherproof labels on machines and in plant rooms
 * Printed at 100% ("actual size"), the labels line up with the sheet.
 */
export type LabelSize = "standard" | "large";

export type PrintableLabel = { code: string; url: string; name: string; track: string; siteName: string | null };

const MM = 72 / 25.4;

const LAYOUTS: Record<LabelSize, {
  cols: number; rows: number; width: number; height: number;
  top: number; left: number; pitchX: number; pitchY: number; pad: number;
  nameSize: number; smallSize: number; codeSize: number;
}> = {
  standard: { cols: 3, rows: 7, width: 63.5, height: 38.1, top: 15.15, left: 7.21, pitchX: 66.04, pitchY: 38.1, pad: 2.5, nameSize: 8.5, smallSize: 6.5, codeSize: 8 },
  large: { cols: 2, rows: 4, width: 99.1, height: 67.7, top: 13.1, left: 4.65, pitchX: 101.6, pitchY: 67.7, pad: 4, nameSize: 12, smallSize: 9, codeSize: 11 },
};

function drawQr(doc: PDFKit.PDFDocument, url: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const cell = size / count;
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.modules.get(row, col)) doc.rect(x + col * cell, y + row * cell, cell + 0.05, cell + 0.05);
    }
  }
  doc.fillColor("#000000").fill();
}

export async function createEquipmentLabelPdf(labels: PrintableLabel[], size: LabelSize, businessName: string): Promise<Buffer> {
  const layout = LAYOUTS[size];
  const doc = new PDFDocument({
    size: "A4", margin: 0, autoFirstPage: false, font: PDF_REGULAR_FONT,
    info: { Title: "Equipment QR labels", Author: businessName, Subject: "ComplyTrack equipment labels" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const perPage = layout.cols * layout.rows;
  labels.forEach((label, index) => {
    if (index % perPage === 0) doc.addPage({ size: "A4", margin: 0 });
    const slot = index % perPage;
    const x = (layout.left + (slot % layout.cols) * layout.pitchX) * MM;
    const y = (layout.top + Math.floor(slot / layout.cols) * layout.pitchY) * MM;
    const pad = layout.pad * MM;
    const height = layout.height * MM;
    const width = layout.width * MM;
    const qrSize = height - 2 * pad;
    drawQr(doc, label.url, x + pad, y + pad, qrSize);

    const textX = x + pad + qrSize + pad * 1.2;
    const textWidth = width - (textX - x) - pad;
    let textY = y + pad;
    doc.font(PDF_BOLD_FONT).fontSize(layout.smallSize * 0.85).fillColor("#3D5A78")
      .text("COMPLYTRACK", textX, textY, { width: textWidth, characterSpacing: 0.4, lineBreak: false });
    textY += layout.smallSize * 1.4;
    doc.font(PDF_BOLD_FONT).fontSize(layout.nameSize).fillColor("#111111")
      .text(label.name, textX, textY, { width: textWidth, height: layout.nameSize * 2.5, ellipsis: true, lineGap: -1 });
    textY = doc.y + 2;
    doc.font(PDF_REGULAR_FONT).fontSize(layout.smallSize).fillColor("#333333")
      .text([label.track, label.siteName].filter(Boolean).join("\n"), textX, textY, { width: textWidth, height: layout.smallSize * 2.6, ellipsis: true });
    // The code sits at the bottom, for reading out or typing in.
    const codeY = y + height - pad - layout.codeSize * 1.2 - layout.smallSize * 1.2;
    doc.font(PDF_BOLD_FONT).fontSize(layout.codeSize).fillColor("#111111")
      .text(label.code, textX, codeY, { width: textWidth, lineBreak: false, characterSpacing: 1 });
    doc.font(PDF_REGULAR_FONT).fontSize(layout.smallSize * 0.85).fillColor("#333333")
      .text("Scan with your phone camera", textX, codeY + layout.codeSize * 1.25, { width: textWidth, lineBreak: false, ellipsis: true });
  });
  if (labels.length === 0) doc.addPage({ size: "A4", margin: 0 });

  doc.end();
  return complete;
}
