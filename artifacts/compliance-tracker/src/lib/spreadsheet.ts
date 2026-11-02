/**
 * Helpers for the import dialogs: reading an uploaded Excel or CSV file (or a
 * Word table or text list), and building the Excel templates people download
 * to fill in.
 */
import * as XLSX from "@e965/xlsx";
import { oldWordRows, oldWordText } from "./word-doc";

/**
 * Excel stores a typed date as a number with a date format, and the default
 * date format is shown US-style (3/31/27). Dates are written as ISO
 * (2027-03-31) instead, so a UK date typed in Excel is never read back with
 * the day and month swapped.
 */
function isoDateCells(sheet: XLSX.WorkSheet) {
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!") || typeof cell !== "object" || cell === null) continue;
    const value = cell as XLSX.CellObject;
    if (value.t !== "n" || typeof value.v !== "number" || !value.z || !XLSX.SSF.is_date(value.z)) continue;
    const parts = XLSX.SSF.parse_date_code(value.v);
    if (!parts?.y) continue;
    value.w = `${parts.y}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, code: string) =>
    code[0] === "#" ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : XML_ENTITIES[code] ?? entity);
}

/** The text of a piece of Word XML, keeping tabs and line breaks typed in it. */
function wordText(xml: string): string {
  // Paragraph and run settings list tab stops as <w:tab .../>; only the
  // tabs inside the text itself count.
  const body = xml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, "").replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, "");
  let text = "";
  for (const match of body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g)) {
    text += match[1] !== undefined ? decodeXml(match[1]) : match[0].startsWith("<w:tab") ? "\t" : "\n";
  }
  return text;
}

/**
 * Lines of text as rows: split on tabs when the text has any (as pasted from
 * a table), otherwise on commas, with "quoted, values" kept together.
 */
export function delimitedRows(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/).filter(line => line.trim());
  if (lines.some(line => line.includes("\t"))) return lines.map(line => line.split("\t").map(cell => cell.trim()));
  return lines.map(splitCommas);
}

/**
 * Split one line on commas. Typed lists often have a space after each comma
 * and Word turns "quotes" into curly ones, so both are allowed around a
 * value that itself contains a comma.
 */
function splitCommas(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const isQuote = char === '"' || char === "\u201C" || char === "\u201D";
    if (isQuote && quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
    else if (isQuote && (quoted || !cell.trim())) { quoted = !quoted; if (quoted) cell = ""; }
    else if (char === "," && !quoted) { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Rows from a Word document: its first table, one table row per record; or,
 * with no table, one line per record with commas or tabs between the values.
 */
export function wordDocumentRows(documentXml: string): string[][] {
  const table = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(documentXml)?.[0];
  if (table) {
    return [...table.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)]
      .map(([row]) => [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(([cell]) =>
        [...cell.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map(([paragraph]) => wordText(paragraph).trim()).filter(Boolean).join(" ")))
      .filter(row => row.some(Boolean));
  }
  const text = [...documentXml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map(([paragraph]) => wordText(paragraph)).join("\n");
  return delimitedRows(text);
}

function readWordDocument(data: Uint8Array): string[][] {
  const zip = XLSX.CFB.read(data, { type: "array" });
  const index = zip.FullPaths.findIndex((path: string) => /\/word\/document\.xml$/i.test(path));
  const entry = index >= 0 ? zip.FileIndex[index] : null;
  if (!entry?.content) throw new Error("This Word file could not be read. Save it again as a Word document (.docx) and try again.");
  return wordDocumentRows(new TextDecoder().decode(entry.content as Uint8Array));
}

/**
 * An old Word (.doc) file: Word 97-2003, or a newer file that was only given
 * a .doc name. Rich text saved as .doc isn't read.
 */
function readOldWordFile(data: Uint8Array): string[][] {
  if (data[0] === 0x50 && data[1] === 0x4B) return readWordDocument(data);
  if (data[0] !== 0xD0 || data[1] !== 0xCF) {
    throw new Error("This Word file could not be read. In Word, choose File > Save As > Word Document (.docx), then upload that.");
  }
  const { table, lines } = oldWordRows(oldWordText(data));
  return table ?? delimitedRows(lines);
}

/**
 * An Excel workbook with several tabs (such as the setup wizard's "What we
 * need from you" workbooks): the tab named `sheet` when there is one, else
 * the first tab that isn't the "Read me" tab, else the first tab.
 */
function pickSheet(names: string[], sheet?: string): string | undefined {
  const lower = (value: string) => value.trim().toLowerCase();
  return (sheet ? names.find((name) => lower(name) === lower(sheet)) : undefined)
    ?? names.find((name) => lower(name) !== "read me")
    ?? names[0];
}

/** Read one sheet of an Excel or CSV file (or a Word table or text list) as a header row plus cell text. */
export async function readSpreadsheet(file: File, options: { sheet?: string } = {}): Promise<{ headers: string[]; rows: string[][] }> {
  const name = file.name.toLowerCase();
  let table: string[][];
  if (/\.doc$/.test(name) || file.type === "application/msword") {
    table = readOldWordFile(new Uint8Array(await file.arrayBuffer()));
  } else if (/\.docx$/.test(name)) {
    table = readWordDocument(new Uint8Array(await file.arrayBuffer()));
  } else if (/\.(txt|tsv)$/.test(name) || file.type === "text/plain") {
    table = delimitedRows(await file.text());
  } else {
    const isCsv = /\.csv$/.test(name) || file.type === "text/csv";
    // CSV text is read raw so "01/02/2027" stays a UK date string instead of
    // being reinterpreted as a US month/day date.
    const workbook = isCsv
      ? XLSX.read(await file.text(), { type: "string", raw: true })
      : XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellNF: true });
    const sheetName = pickSheet(workbook.SheetNames, options.sheet);
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) return { headers: [], rows: [] };
    if (!isCsv) isoDateCells(sheet);
    table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false, dateNF: "yyyy-mm-dd" })
      .map(row => row.map(value => String(value ?? "")));
  }
  const [headers = [], ...rows] = table;
  return { headers, rows };
}

/** The tab names of an Excel workbook (none for CSV, Word or text files). */
export async function spreadsheetTabNames(file: File): Promise<string[]> {
  const name = file.name.toLowerCase();
  if (!/\.(xlsx|xlsm|xls|ods)$/.test(name)) return [];
  return XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", bookSheets: true }).SheetNames;
}

/**
 * Save rows as an .xlsx file. Every cell is stored as text so examples such
 * as "31/03/2027" or "0012" look the same in Excel as they do here.
 */
export function downloadExcel(filename: string, sheetName: string, rows: string[][]) {
  const sheet = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(value => ({ t: "s", v: value }))));
  const widths = (rows[0] ?? []).map((_, column) => Math.min(60, Math.max(12, ...rows.map(row => (row[column] ?? "").length + 2))));
  sheet["!cols"] = widths.map(wch => ({ wch }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31));
  XLSX.writeFile(workbook, filename);
}

/** A workbook cell: text, or a formula Excel works out (shown with `format`). */
export type WorkbookCell = string | { formula: string; format?: string };

/**
 * Save several tabs as one .xlsx file. Text cells are stored as text (see
 * downloadExcel); formula cells are left for Excel to calculate.
 */
export function downloadWorkbook(filename: string, sheets: { name: string; rows: WorkbookCell[][] }[]) {
  const workbook = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(value => typeof value === "string"
      ? { t: "s", v: value }
      : { t: "n", f: value.formula, ...(value.format ? { z: value.format } : {}) })));
    const columns = Math.max(0, ...rows.map(row => row.length));
    // Titles and notes above the headings (a single long cell) don't widen the column.
    const width = (value: WorkbookCell | undefined, row: WorkbookCell[]) => typeof value === "string" && row.length > 1 ? value.length + 2 : 12;
    sheet["!cols"] = Array.from({ length: columns }, (_, column) => ({ wch: Math.min(48, Math.max(12, ...rows.map(row => width(row[column], row)))) }));
    XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
  }
  XLSX.writeFile(workbook, filename);
}

/** Turn a CSV template (as the API serves it) into an Excel template. */
export function downloadCsvAsExcel(filename: string, sheetName: string, csv: string) {
  const workbook = XLSX.read(csv.replace(/^﻿/, ""), { type: "string", raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false }) : [];
  downloadExcel(filename, sheetName, rows.map(row => row.map(value => String(value ?? ""))));
}
