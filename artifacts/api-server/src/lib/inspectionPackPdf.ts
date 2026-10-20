import PDFDocument from "pdfkit";
import type { Writable } from "node:stream";
import type { Capped, InspectionPackData, SummaryRow } from "./inspectionPack";
import { PDF_BOLD_FONT, PDF_REGULAR_FONT } from "./pdfFonts";

// Same fonts and palette as the pest-control and cleaning-schedule registers.
const REGULAR_FONT = PDF_REGULAR_FONT;
const BOLD_FONT = PDF_BOLD_FONT;
const INK = "#111827";
const MUTED = "#4b5563";
const RULE = "#9ca3af";
const ALERT = "#991b1b";
const LEFT = 32;
const RIGHT = 810; // A4 landscape width (842) minus the right margin.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** YYYY-MM-DD → "1 Sep 2026" (UK date, independent of server locale data). */
export function ukDate(date: string | null | undefined): string {
  if (!date) return "—";
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return "—";
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** Instant → "12 Oct 2026, 14:05" in Europe/London. */
export function ukDateTime(instant: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).map(part => [part.type, part.value]));
  return `${ukDate(`${parts.year}-${parts.month}-${parts.day}`)}, ${parts.hour}:${parts.minute}`;
}

const label = (value: string) => value.replace(/_/g, " ").replace(/^./, first => first.toUpperCase());
const count = (value: number | null) => (value === null ? "—" : String(value));

type Column = { header: string; width: number; align?: "left" | "right" };
type Cell = string | { text: string; alert?: boolean };

function ensureSpace(doc: PDFKit.PDFDocument, height: number): boolean {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom - 14) {
    doc.addPage();
    return true;
  }
  return false;
}

function sectionHeading(doc: PDFKit.PDFDocument, title: string, intro?: string): void {
  ensureSpace(doc, 90);
  doc.moveDown(0.6).font(BOLD_FONT).fontSize(13).fillColor(INK).text(title, LEFT);
  doc.moveDown(0.2).strokeColor(RULE).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
  doc.moveDown(0.4);
  if (intro) doc.font(REGULAR_FONT).fontSize(8.5).fillColor(MUTED).text(intro, LEFT, doc.y, { width: RIGHT - LEFT }).moveDown(0.4);
}

function note(doc: PDFKit.PDFDocument, value: string, colour = MUTED): void {
  ensureSpace(doc, 20);
  doc.font(REGULAR_FONT).fontSize(8.5).fillColor(colour).text(value, LEFT, doc.y, { width: RIGHT - LEFT }).moveDown(0.3);
}

/** A wrapped table whose header repeats after each page break. */
function table(doc: PDFKit.PDFDocument, columns: Column[], rows: Cell[][]): void {
  const padding = 3;
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  const scale = (RIGHT - LEFT) / total;
  const widths = columns.map(column => column.width * scale);
  // Right-aligned (numeric) cells keep a gap before the next column.
  const textWidth = (index: number) => widths[index] - padding * 2 - (columns[index].align === "right" ? 8 : 0);
  const drawRow = (cells: Cell[], header: boolean) => {
    const height = Math.max(...cells.map((cell, index) => {
      const bold = header || (typeof cell !== "string" && cell.alert);
      doc.font(bold ? BOLD_FONT : REGULAR_FONT).fontSize(8);
      return doc.heightOfString(typeof cell === "string" ? cell : cell.text, { width: textWidth(index) });
    })) + padding * 2;
    if (ensureSpace(doc, height + 2) && !header) drawRow(columns.map(column => column.header), true);
    const top = doc.y;
    if (header) doc.rect(LEFT, top, RIGHT - LEFT, height).fill("#f3f4f6");
    let x = LEFT;
    cells.forEach((cell, index) => {
      const value = typeof cell === "string" ? cell : cell.text;
      const alert = typeof cell !== "string" && cell.alert;
      doc.font(header || alert ? BOLD_FONT : REGULAR_FONT).fontSize(8).fillColor(alert ? ALERT : INK)
        .text(value, x + padding, top + padding, { width: textWidth(index), align: columns[index].align ?? "left" });
      x += widths[index];
    });
    doc.y = top + height;
    doc.strokeColor("#e5e7eb").moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
  };
  drawRow(columns.map(column => column.header), true);
  for (const row of rows) drawRow(row, false);
  doc.x = LEFT;
  doc.moveDown(0.5);
}

function moreNote(doc: PDFKit.PDFDocument, list: Capped<unknown>): void {
  if (list.total > list.rows.length) note(doc, `${list.total - list.rows.length} more in the CSV export.`);
}

function summaryRows(rows: SummaryRow[]): Cell[][] {
  return rows.map(row => [
    row.module,
    count(row.due),
    String(row.recorded),
    row.exceptions ? { text: String(row.exceptions), alert: true } : count(row.exceptions),
    row.overdue ? { text: String(row.overdue), alert: true } : count(row.overdue),
    row.openActions ? { text: String(row.openActions), alert: true } : count(row.openActions),
  ]);
}

const RIDDOR_CATEGORY: Record<string, string> = {
  death: "Death",
  specified_injury: "Specified injury",
  over_7_day_injury: "Over-7-day incapacitation",
  non_worker_hospital: "Non-worker taken to hospital",
  occupational_disease: "Occupational disease",
  dangerous_occurrence: "Dangerous occurrence",
  over_3_day_record_only: "Over-3-day (record only)",
};

function riddorText(row: NonNullable<InspectionPackData["incidents"]>["rows"][number]): Cell {
  if (!row.riddorCategory) {
    if (!row.riddorReportable) return "Not reportable";
    return row.reportedToHse ? "Reportable — reported to HSE" : { text: "Reportable — category not set", alert: true };
  }
  const category = RIDDOR_CATEGORY[row.riddorCategory] ?? label(row.riddorCategory);
  switch (row.riddorState) {
    case "reported": return `${category} — reported to HSE`;
    case "overdue": return { text: `${category} — report overdue (was due ${ukDate(row.reportBy)})`, alert: true };
    case "due": return `${category} — report by ${ukDate(row.reportBy)}`;
    case "on_diagnosis": return `${category} — report on written diagnosis`;
    case "record_only": return `${category} — not reportable`;
    default: return category;
  }
}

/**
 * Write the inspection pack PDF to `output` (e.g. an HTTP response). Data is
 * gathered beforehand, so a failure here only affects the stream.
 */
export function writeInspectionPackPdf(pack: InspectionPackData, output: Writable): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 36, right: 32, bottom: 36, left: LEFT },
    font: REGULAR_FONT,
    bufferPages: true,
    info: {
      Title: "Inspection pack",
      Author: pack.businessName,
      Subject: `Records summary ${pack.from} to ${pack.to}`,
    },
  });
  doc.pipe(output);

  // ── Cover ──────────────────────────────────────────────────────────────────
  doc.moveDown(4);
  doc.font(BOLD_FONT).fontSize(26).fillColor(INK).text("Inspection pack", LEFT);
  doc.moveDown(0.4).font(BOLD_FONT).fontSize(16).text(pack.businessName || "Business name not recorded");
  doc.moveDown(1.2).font(REGULAR_FONT).fontSize(11);
  const coverLine = (name: string, value: string) => {
    doc.font(BOLD_FONT).fillColor(INK).text(`${name}: `, LEFT, doc.y, { continued: true });
    doc.font(REGULAR_FONT).text(value);
    doc.moveDown(0.3);
  };
  coverLine("Site", pack.siteLabel);
  coverLine("Period", `${ukDate(pack.from)} to ${ukDate(pack.to)} (${pack.totalDays} day${pack.totalDays === 1 ? "" : "s"})`);
  coverLine("Generated", `${ukDateTime(pack.generatedAt)} (UK time)`);
  coverLine("Generated by", pack.generatedBy || "—");
  doc.moveDown(1.5).font(REGULAR_FONT).fontSize(9).fillColor(MUTED).text(
    "This pack summarises the records kept in ComplyTrack for the site and period shown. Each section gives "
    + "counts and lists the exceptions in full; long lists are shortened and the remaining rows are in the CSV "
    + "export. Only modules this business uses are included. Incident entries leave out personal, injury and "
    + "health details. The pack reflects what has been recorded; it is not a certificate or an inspection result.",
    LEFT, doc.y, { width: 520 },
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  doc.addPage();
  sectionHeading(doc, "Summary by module",
    "Due: records the schedule expects in the period (— where no schedule applies). Exceptions: failed checks, "
    + "out-of-range readings, RIDDOR-reportable incidents or expiring documents. Overdue and open actions are as at "
    + "the generation date.");
  table(doc, [
    { header: "Module", width: 230 },
    { header: "Due in period", width: 80, align: "right" },
    { header: "Recorded", width: 80, align: "right" },
    { header: "Exceptions", width: 80, align: "right" },
    { header: "Overdue / missed", width: 90, align: "right" },
    { header: "Open actions", width: 80, align: "right" },
  ], summaryRows(pack.summary));

  // ── Compliance checks ──────────────────────────────────────────────────────
  sectionHeading(doc, `Compliance checks (${pack.compliance.total})`,
    "Statutory and contractor checks such as gas safety, EICR and LOLER. Overdue and due-soon checks are listed first.");
  if (pack.compliance.total === 0) note(doc, "No compliance checks with a due date or completion for this scope.");
  else {
    table(doc, [
      { header: "Check", width: 190 }, { header: "Category", width: 90 }, { header: "Site", width: 90 },
      { header: "Last completed", width: 75 }, { header: "Next due", width: 75 }, { header: "Status", width: 65 },
      { header: "Certificates", width: 160 },
    ], pack.compliance.rows.map(row => [
      row.title, row.category ?? "—", row.siteName ?? "All sites", ukDate(row.lastCompleted), ukDate(row.nextDue),
      row.status === "Overdue" || row.status === "Action required" ? { text: row.status, alert: true } : row.status,
      [row.actionNote, row.certificates.length ? row.certificates.join(", ") : "None uploaded"].filter(Boolean).join(" — "),
    ]));
    moreNote(doc, pack.compliance);
  }
  if (pack.compliance.unscheduled) {
    note(doc, `${pack.compliance.unscheduled} further check${pack.compliance.unscheduled === 1 ? " has" : "s have"} no due date and no completion recorded.`);
  }

  // ── Fire ───────────────────────────────────────────────────────────────────
  if (pack.fire) {
    sectionHeading(doc, "Fire safety check log", "Counts per check in the period; next due uses each site's check frequency.");
    table(doc, [
      { header: "Check", width: 220 }, { header: "Recorded", width: 60, align: "right" },
      { header: "Failed", width: 55, align: "right" }, { header: "Last done", width: 80 },
      { header: "Next due", width: 80 }, { header: "Status", width: 200 },
    ], pack.fire.types.map(row => [
      row.label, String(row.recorded), row.failed ? { text: String(row.failed), alert: true } : "0",
      ukDate(row.lastDone), ukDate(row.nextDue),
      row.status.startsWith("Overdue") ? { text: row.status, alert: true } : row.status,
    ]));
    if (pack.fire.exceptions.total === 0) note(doc, "No failed fire safety checks in this period.");
    else {
      note(doc, `Failed checks (${pack.fire.exceptions.total}):`, INK);
      table(doc, [
        { header: "Date", width: 70 }, { header: "Site", width: 110 }, { header: "Check", width: 190 },
        { header: "Location", width: 120 }, { header: "Notes", width: 250 },
      ], pack.fire.exceptions.rows.map(row => [
        ukDate(row.date), row.siteName ?? "No site", row.check, row.location ?? "—", row.notes ?? "—",
      ]));
      moreNote(doc, pack.fire.exceptions);
    }
  }

  // ── Legionella ─────────────────────────────────────────────────────────────
  if (pack.legionella) {
    sectionHeading(doc, "Legionella temperature log",
      "Readings outside the site's limits are saved as failed checks and listed below. Due dates come only from an approved site monitoring plan.");
    // Without an approved plan, unused check types would only add empty rows.
    const waterTypes = pack.legionella.types
      .filter(row => row.recorded > 0 || row.lastDone || row.status !== "No schedule");
    if (waterTypes.length === 0) note(doc, "No legionella checks have been recorded for this scope.");
    else {
      table(doc, [
        { header: "Check", width: 250 }, { header: "Recorded", width: 60, align: "right" },
        { header: "Failed", width: 55, align: "right" }, { header: "Last done", width: 80 },
        { header: "Next due", width: 80 }, { header: "Status", width: 170 },
      ], waterTypes.map(row => [
        row.label, String(row.recorded), row.failed ? { text: String(row.failed), alert: true } : "0",
        ukDate(row.lastDone), ukDate(row.nextDue),
        row.status.startsWith("Overdue") ? { text: row.status, alert: true } : row.status,
      ]));
    }
    if (pack.legionella.sitesWithoutPlan.length) {
      note(doc, `No approved monitoring plan, so no due dates: ${pack.legionella.sitesWithoutPlan.join(", ")}.`, ALERT);
    }
    if (pack.legionella.exceptions.total === 0) note(doc, "No out-of-range readings or failed checks in this period.");
    else {
      note(doc, `Out-of-range readings and failed checks (${pack.legionella.exceptions.total}):`, INK);
      table(doc, [
        { header: "Date", width: 70 }, { header: "Site", width: 110 }, { header: "Check", width: 210 },
        { header: "Reading", width: 60 }, { header: "Outlet / location", width: 120 }, { header: "Notes", width: 170 },
      ], pack.legionella.exceptions.rows.map(row => [
        ukDate(row.date), row.siteName ?? "No site", row.check,
        row.reading ? { text: row.reading, alert: true } : "—", row.location ?? "—", row.notes ?? "—",
      ]));
      moreNote(doc, pack.legionella.exceptions);
    }
  }

  // ── Kitchen ────────────────────────────────────────────────────────────────
  if (pack.kitchen) {
    sectionHeading(doc, "Kitchen temperatures and daily diary",
      "Days with a submitted food safety diary, and every out-of-range temperature with the corrective action recorded.");
    if (pack.kitchen.sites.length === 0) note(doc, "No kitchen diaries have been recorded for this scope.");
    else {
      table(doc, [
        { header: "Site", width: 300 }, { header: "Days in period", width: 100, align: "right" },
        { header: "Diaries submitted", width: 110, align: "right" }, { header: "Days missing", width: 100, align: "right" },
      ], pack.kitchen.sites.map(site => {
        const missing = Math.max(0, site.expectedDays - site.submittedDays);
        return [site.siteName, String(site.expectedDays), String(site.submittedDays),
          missing ? { text: String(missing), alert: true } : "0"];
      }));
    }
    if (pack.kitchen.failures.total === 0) note(doc, "No out-of-range temperatures recorded in this period.");
    else {
      note(doc, `Out-of-range temperatures (${pack.kitchen.failures.total}, ${pack.kitchen.openActions} still open):`, INK);
      table(doc, [
        { header: "Date", width: 70 }, { header: "Site", width: 110 }, { header: "Reading", width: 270 },
        { header: "Corrective action", width: 220 }, { header: "Action", width: 60 },
      ], pack.kitchen.failures.rows.map(row => [
        ukDate(row.date), row.siteName ?? "No site", row.reading, row.correctiveAction ?? "—",
        row.status === "Open" ? { text: "Open", alert: true } : row.status,
      ]));
      moreNote(doc, pack.kitchen.failures);
    }
  }

  // ── Daily checklists ───────────────────────────────────────────────────────
  if (pack.checklists) {
    sectionHeading(doc, "Daily checklist completion", "Days in the period with a submitted opening (AM) or closing (PM) checklist.");
    if (pack.checklists.length === 0) note(doc, "No sites in this scope.");
    else {
      table(doc, [
        { header: "Site", width: 300 }, { header: "Checklist", width: 80 },
        { header: "Expected", width: 80, align: "right" }, { header: "Submitted", width: 80, align: "right" },
        { header: "Missed", width: 80, align: "right" }, { header: "Completion", width: 80, align: "right" },
      ], pack.checklists.map(row => [
        row.siteName, row.period, String(row.expected), String(row.submitted),
        row.missed ? { text: String(row.missed), alert: true } : "0",
        row.expected ? `${Math.round((row.submitted / row.expected) * 100)}%` : "—",
      ]));
    }
  }

  // ── Incidents ──────────────────────────────────────────────────────────────
  if (pack.incidents) {
    sectionHeading(doc, `Incidents (${pack.incidents.total})`,
      "Incident type, status and RIDDOR reporting state only. Names, descriptions, injuries and health details are not included.");
    if (pack.incidents.total === 0) note(doc, "No incidents recorded in this period.");
    else {
      table(doc, [
        { header: "Date", width: 70 }, { header: "Site", width: 110 }, { header: "Type", width: 110 },
        { header: "Severity", width: 70 }, { header: "Status", width: 90 }, { header: "RIDDOR", width: 235 },
        { header: "Open actions", width: 85, align: "right" },
      ], pack.incidents.rows.map(row => [
        ukDate(row.date), row.siteName ?? "No site", label(row.type), label(row.severity), label(row.status),
        riddorText(row), row.openActions ? { text: String(row.openActions), alert: true } : "0",
      ]));
      moreNote(doc, pack.incidents);
    }
  }

  // ── Contractors ────────────────────────────────────────────────────────────
  sectionHeading(doc, `Contractors (${pack.contractors.total})`,
    "Insurance, DBS/PVG recheck and accreditation dates. Expired and due-soon (within 60 days) contractors are listed first.");
  if (pack.contractors.total === 0) note(doc, "No contractors are recorded.");
  else {
    table(doc, [
      { header: "Contractor", width: 200 }, { header: "Public liability", width: 85 },
      { header: "Prof. indemnity", width: 85 }, { header: "DBS/PVG recheck", width: 85 },
      { header: "Next accreditation expiry", width: 170 }, { header: "Status", width: 70 },
    ], pack.contractors.rows.map(row => [
      row.name, ukDate(row.publicLiabilityExpiry), ukDate(row.indemnityExpiry), ukDate(row.dbsRecheck),
      row.nextAccreditationExpiry ? `${row.nextAccreditationName ?? "Accreditation"} — ${ukDate(row.nextAccreditationExpiry)}` : "—",
      row.status === "Expired" || row.status === "Due soon" ? { text: row.status, alert: true } : row.status,
    ]));
    moreNote(doc, pack.contractors);
  }

  // ── Training ───────────────────────────────────────────────────────────────
  if (pack.training) {
    sectionHeading(doc, `Training expired or expiring within 60 days (${pack.training.total})`,
      "Latest record of each training per person; renewed training is not listed.");
    if (pack.training.total === 0) note(doc, "No training records have expired or expire within 60 days.");
    else {
      table(doc, [
        { header: "Staff member", width: 170 }, { header: "Training", width: 250 }, { header: "Site", width: 140 },
        { header: "Expiry", width: 90 }, { header: "Status", width: 80 },
      ], pack.training.rows.map(row => [
        row.staffName, row.training, row.siteName ?? "All sites", ukDate(row.expiryDate),
        row.status === "Expired" ? { text: "Expired", alert: true } : "Due soon",
      ]));
      moreNote(doc, pack.training);
    }
  }

  // ── Footer on every page ───────────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index++) {
    doc.switchToPage(index);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(REGULAR_FONT).fontSize(7.5).fillColor(MUTED).text(
      `${pack.businessName} · ${pack.siteLabel} · ${ukDate(pack.from)} to ${ukDate(pack.to)} · Page ${index + 1} of ${range.count}`,
      LEFT, doc.page.height - 24, { width: RIGHT - LEFT, align: "center", lineBreak: false },
    );
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return doc;
}
