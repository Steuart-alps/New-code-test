import PDFDocument from "pdfkit";

export interface PestControlVisitRow {
  date: string;
  site: string;
  contractor: string;
  areas: string;
  findings: string;
  treatments: string;
  recommendations: string;
  nextVisit: string;
  signedOffBy: string;
  notes: string;
}

export interface PestControlActivityRow {
  date: string;
  site: string;
  type: string;
  location: string;
  severity: string;
  actionTaken: string;
  recordedBy: string;
  resolvedStatus: string;
  notes: string;
}

export interface PestControlRegister {
  businessName: string;
  generatedAt: string;
  visits: PestControlVisitRow[];
  activity: PestControlActivityRow[];
}

const REGULAR_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function valueOrFallback(value: string): string {
  return value.trim() || "Not recorded";
}

function field(doc: PDFKit.PDFDocument, label: string, value: string): void {
  doc.font(BOLD_FONT).text(`${label}: `, { continued: true });
  doc.font(REGULAR_FONT).text(valueOrFallback(value));
}

function sectionHeading(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.5).font(BOLD_FONT).fontSize(13).fillColor("#1f2937").text(title);
  doc.moveDown(0.2).strokeColor("#9ca3af").moveTo(doc.x, doc.y).lineTo(810, doc.y).stroke();
  doc.moveDown(0.5);
}

function recordHeading(doc: PDFKit.PDFDocument, title: string): void {
  if (doc.y > 500) doc.addPage();
  doc.font(BOLD_FONT).fontSize(10).fillColor("#111827").text(title);
  doc.fontSize(8).fillColor("#111827");
}

export async function createPestControlRegisterPdf(register: PestControlRegister): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 36, right: 32, bottom: 36, left: 32 },
    font: REGULAR_FONT,
    info: {
      Title: "Pest Control Register",
      Author: register.businessName,
      Subject: "Environmental health and food safety inspection record",
    },
    autoFirstPage: true,
  });
  doc.registerFont("RegisterRegular", REGULAR_FONT);
  doc.registerFont("RegisterBold", BOLD_FONT);
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font(BOLD_FONT).fontSize(18).fillColor("#111827").text("Pest Control Register");
  doc.font(BOLD_FONT).fontSize(11).text(valueOrFallback(register.businessName));
  doc.font(REGULAR_FONT).fontSize(8).fillColor("#4b5563")
    .text(`Generated: ${register.generatedAt} · Prepared for environmental health and food safety inspections`);

  sectionHeading(doc, `Contractor visits (${register.visits.length})`);
  if (register.visits.length === 0) {
    doc.font(REGULAR_FONT).fontSize(9).text("No contractor visits recorded.");
  }
  register.visits.forEach((row, index) => {
    recordHeading(doc, `Visit ${index + 1} — ${row.date}`);
    field(doc, "Site", row.site);
    field(doc, "Contractor", row.contractor);
    field(doc, "Areas inspected", row.areas);
    field(doc, "Findings", row.findings);
    field(doc, "Treatments applied", row.treatments);
    field(doc, "Recommendations", row.recommendations);
    field(doc, "Next visit", row.nextVisit);
    field(doc, "Signed off by", row.signedOffBy);
    field(doc, "Notes", row.notes);
    doc.moveDown(0.6);
  });

  sectionHeading(doc, `Activity log (${register.activity.length})`);
  if (register.activity.length === 0) {
    doc.font(REGULAR_FONT).fontSize(9).text("No pest activity recorded.");
  }
  register.activity.forEach((row, index) => {
    recordHeading(doc, `Activity ${index + 1} — ${row.date}`);
    field(doc, "Site", row.site);
    field(doc, "Type", row.type);
    field(doc, "Location", row.location);
    field(doc, "Severity", row.severity);
    field(doc, "Action taken", row.actionTaken);
    field(doc, "Recorded by", row.recordedBy);
    field(doc, "Resolved status", row.resolvedStatus);
    field(doc, "Notes", row.notes);
    doc.moveDown(0.6);
  });

  doc.end();
  return complete;
}