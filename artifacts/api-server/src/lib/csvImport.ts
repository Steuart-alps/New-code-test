/**
 * Register CSV imports (PATTrack appliances, RoomTrack rooms, contractors,
 * FireTrack call points, compliance checks).
 *
 * Mirrors the staff-roster reconciliation: the browser reads the spreadsheet
 * (Excel or CSV) and sends its header row and cell text; the API maps the
 * headers, validates every row, previews what would happen and only writes
 * when the whole file is valid, in one transaction (routes/csv-imports.ts).
 *
 * Everything in this file is pure so it can be unit tested without a database.
 */
import { PAT_APPLIANCE_TYPES } from "@workspace/db/schema";

export const CSV_IMPORT_TYPES = ["pat-appliances", "room-track-rooms", "contractors", "fire-call-points", "compliance-checks"] as const;
export type CsvImportType = (typeof CSV_IMPORT_TYPES)[number];

export function isCsvImportType(value: unknown): value is CsvImportType {
  return typeof value === "string" && (CSV_IMPORT_TYPES as readonly string[]).includes(value);
}

export const CSV_IMPORT_MAX_ROWS = 1000;
export const CSV_IMPORT_MAX_COLUMNS = 40;
export const CSV_IMPORT_MAX_CELL_LENGTH = 2000;

type ColumnKind = "text" | "email" | "date" | "list";

export interface CsvImportColumn {
  key: string;
  label: string;
  /** Normalised header spellings accepted for this column (see normaliseHeader). */
  aliases: string[];
  required?: boolean;
  max: number;
  kind?: ColumnKind;
  example: string;
}

export const CSV_IMPORT_COLUMNS: Record<CsvImportType, CsvImportColumn[]> = {
  "pat-appliances": [
    { key: "name", label: "Appliance name", aliases: ["appliancename", "name", "appliance", "item", "itemname"], required: true, max: 200, example: "Kettle" },
    { key: "assetTag", label: "Asset tag", aliases: ["assettag", "asset", "tag", "assetno", "assetnumber", "assetid"], max: 100, example: "PAT-0001" },
    { key: "applianceType", label: "Appliance type", aliases: ["appliancetype", "type", "class", "category"], max: 100, example: "Kitchen Appliance" },
    { key: "site", label: "Site", aliases: ["site", "sitename"], max: 200, example: "Main building" },
    { key: "location", label: "Location", aliases: ["location", "room", "area"], max: 200, example: "Staff kitchen" },
    { key: "description", label: "Notes", aliases: ["notes", "note", "description", "comments"], max: 1000, example: "" },
  ],
  "room-track-rooms": [
    { key: "roomNumber", label: "Room number", aliases: ["roomnumber", "roomno", "room", "number", "roomref"], required: true, max: 100, example: "101" },
    { key: "name", label: "Room name", aliases: ["roomname", "name"], max: 200, example: "Garden suite" },
    { key: "floor", label: "Floor", aliases: ["floor", "level", "storey"], max: 100, example: "Ground" },
    { key: "site", label: "Site", aliases: ["site", "sitename"], max: 200, example: "Main building" },
    { key: "notes", label: "Notes", aliases: ["notes", "note", "comments"], max: 5000, example: "" },
  ],
  contractors: [
    { key: "name", label: "Contact name", aliases: ["contactname", "name", "contact", "fullname"], required: true, max: 200, example: "Sam Patel" },
    { key: "company", label: "Company", aliases: ["company", "companyname", "business", "organisation", "organization"], max: 200, example: "Patel Electrical Ltd" },
    { key: "email", label: "Email", aliases: ["email", "emailaddress", "mail"], required: true, max: 254, kind: "email", example: "sam@example.co.uk" },
    { key: "phone", label: "Phone", aliases: ["phone", "telephone", "tel", "mobile", "phonenumber"], max: 50, example: "01234 567890" },
    { key: "address", label: "Address", aliases: ["address", "postaladdress"], max: 500, example: "" },
    { key: "trades", label: "Trades", aliases: ["trades", "trade", "services"], max: 1000, kind: "list", example: "Electrical" },
    { key: "gasSafeNumber", label: "Gas Safe number", aliases: ["gassafenumber", "gassafe", "gassafeno", "gassaferegistration"], max: 30, example: "" },
    { key: "publicLiabilityExpiry", label: "Public liability expiry", aliases: ["publicliabilityexpiry", "plexpiry", "publicliability", "insuranceexpiry"], max: 20, kind: "date", example: "31/03/2027" },
    { key: "notes", label: "Notes", aliases: ["notes", "note", "comments"], max: 2000, example: "" },
  ],
  // Rows are listed in rotation order: new call points join the end of their
  // site's rotation in the order the file gives them.
  "fire-call-points": [
    { key: "name", label: "Call point", aliases: ["callpoint", "callpointname", "callpointref", "callpointreference", "callpointnumber", "callpointno", "name", "reference", "ref", "cp", "cpno", "cpnumber", "cpref", "number"], required: true, max: 200, example: "CP1" },
    { key: "location", label: "Location", aliases: ["location", "callpointlocation", "where", "area", "position", "description"], max: 200, example: "Reception, main entrance" },
    { key: "site", label: "Site", aliases: ["site", "sitename"], max: 200, example: "" },
  ],
  // A business's own compliance checklist, as most keep it: one line per
  // contractor service (lib/complianceCheckImport.ts). "Last done" is read
  // leniently: text that is not a date ("5 minute function test") is kept as
  // a note. A "Status" or days-left column is not needed and is left out.
  "compliance-checks": [
    { key: "title", label: "Check", aliases: ["check", "checkname", "compliancecheck", "item", "itemname", "title", "task", "inspection", "service", "name"], required: true, max: 300, example: "Fire Alarm Maintenance" },
    { key: "repeat", label: "Repeat", aliases: ["repeat", "repeatevery", "timeperiod", "frequency", "interval", "period", "howoften", "every", "repeatmonths", "frequencymonths"], max: 100, example: "6 monthly" },
    { key: "lastDone", label: "Last done", aliases: ["lastdone", "lastcompleted", "completed", "datecompleted", "datelastcompleted", "lastservice", "lastservicedate", "lastinspection", "lastinspected", "lastchecked", "lastvisit", "lastdate", "done"], max: 200, example: "28/09/2026" },
    { key: "dueDate", label: "Next due", aliases: ["nextdue", "nextduedate", "duedate", "due", "nextdate", "renewaldate", "expirydate", "expiry"], max: 20, kind: "date", example: "28/03/2027" },
    { key: "contractor", label: "Contractor", aliases: ["contractor", "contractorname", "contractorcompany", "company", "supplier", "provider", "carriedoutby", "engineer"], max: 200, example: "Acme Fire" },
    { key: "phone", label: "Contractor phone", aliases: ["contractorphone", "telephonenumber", "telephone", "phone", "phonenumber", "tel", "contactnumber", "mobile"], max: 50, example: "" },
    { key: "email", label: "Contractor email", aliases: ["contractoremail", "emailaddress", "email", "mail"], max: 254, kind: "email", example: "" },
    { key: "site", label: "Site", aliases: ["site", "sitename"], max: 200, example: "" },
    { key: "category", label: "Category", aliases: ["category", "section", "area"], max: 100, example: "" },
    { key: "notes", label: "Notes", aliases: ["notes", "note", "comments", "comment"], max: 2000, example: "" },
  ],
};

/** The natural key each register is matched on, for the template help text. */
export const CSV_IMPORT_KEYS: Record<CsvImportType, string> = {
  "pat-appliances": "Asset tag, or appliance name + site + location when there is no asset tag",
  "room-track-rooms": "Site + room number",
  contractors: "Email",
  "fire-call-points": "Site + call point",
  "compliance-checks": "Check name (matched to ComplyTrack's own check where there is one) + site",
};

export const normaliseHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Case- and whitespace-insensitive comparison key for names and identifiers. */
export const normaliseKey = (value: string | null | undefined) =>
  (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");

export interface CsvImportInput {
  headers: string[];
  rows: string[][];
}

export interface MappedRow {
  /** Spreadsheet row number (the header is row 1). */
  row: number;
  values: Record<string, string | null>;
  errors: string[];
}

export interface MappedImport {
  rows: MappedRow[];
  /** File-level problems (missing required columns etc.); nothing is mapped when present. */
  fileErrors: string[];
  ignoredHeaders: string[];
}

/** Map spreadsheet headers to columns and validate each cell's shape. */
export function mapImportRows(type: CsvImportType, input: CsvImportInput): MappedImport {
  const columns = CSV_IMPORT_COLUMNS[type];
  // A title above the headings ("Compliance Checklist", then the headings on
  // row 3): use the first of the top rows that has every required heading.
  const required = columns.filter((column) => column.required);
  const hasRequired = (headers: string[]) => required.every((column) => headers.some((header) => column.aliases.includes(normaliseHeader(String(header ?? "")))));
  let skipped = 0;
  if (!hasRequired(input.headers)) {
    const found = input.rows.slice(0, 10).findIndex((row) => hasRequired(row));
    if (found >= 0) {
      skipped = found + 1;
      input = { headers: input.rows[found].map((header) => String(header ?? "")), rows: input.rows.slice(found + 1) };
    }
  }
  const fileErrors: string[] = [];
  const headerIndex = new Map<string, number>();
  const ignoredHeaders: string[] = [];
  input.headers.forEach((header, index) => {
    const normalised = normaliseHeader(header);
    const column = columns.find((candidate) => candidate.aliases.includes(normalised));
    if (!column) {
      if (header.trim()) ignoredHeaders.push(header.trim());
      return;
    }
    // First matching header wins, so "Name" does not overwrite "Appliance name".
    if (!headerIndex.has(column.key)) headerIndex.set(column.key, index);
    else ignoredHeaders.push(header.trim());
  });
  for (const column of columns) {
    if (column.required && !headerIndex.has(column.key)) fileErrors.push(`Missing required column "${column.label}"`);
  }
  if (input.rows.length > CSV_IMPORT_MAX_ROWS) fileErrors.push(`The file has ${input.rows.length} rows; the maximum is ${CSV_IMPORT_MAX_ROWS}`);
  if (fileErrors.length) return { rows: [], fileErrors, ignoredHeaders };

  const rows: MappedRow[] = [];
  input.rows.forEach((cells, index) => {
    // A blank spreadsheet line, or one with text only in columns not imported
    // (a "Status" formula column carried down past the last check).
    if ([...headerIndex.values()].every((position) => !String(cells[position] ?? "").trim())) return;
    const values: Record<string, string | null> = {};
    const errors: string[] = [];
    for (const column of columns) {
      const position = headerIndex.get(column.key);
      const raw = position === undefined ? "" : String(cells[position] ?? "");
      // Free-text cells keep their line breaks; identifiers collapse spacing.
      const freeText = column.key === "notes" || column.key === "description" || column.key === "address";
      const value = freeText ? raw.trim() : raw.trim().replace(/\s+/g, " ");
      if (!value) {
        values[column.key] = null;
        if (column.required) errors.push(`${column.label} is required`);
        continue;
      }
      if (value.length > column.max) {
        errors.push(`${column.label} must be ${column.max} characters or fewer`);
        values[column.key] = null;
        continue;
      }
      if (column.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors.push(`${column.label} "${value}" is not a valid email address`);
      }
      if (column.kind === "date") {
        const iso = parseImportDate(value);
        if (!iso) {
          errors.push(`${column.label} "${value}" is not a date (use DD/MM/YYYY)`);
          values[column.key] = null;
          continue;
        }
        values[column.key] = iso;
        continue;
      }
      values[column.key] = value;
    }
    if (type === "pat-appliances" && values.applianceType) {
      const match = PAT_APPLIANCE_TYPES.find((candidate) => normaliseKey(candidate) === normaliseKey(values.applianceType));
      if (match) values.applianceType = match;
      else errors.push(`Appliance type "${values.applianceType}" is not recognised (use one of: ${PAT_APPLIANCE_TYPES.join(", ")})`);
    }
    if ((type === "contractors" || type === "compliance-checks") && values.email) values.email = values.email.toLowerCase();
    rows.push({ row: index + skipped + 2, values, errors });
  });
  return { rows, fileErrors, ignoredHeaders };
}

/** UK DD/MM/YYYY (or D/M/YY) and ISO YYYY-MM-DD; returns ISO or null. */
export function parseImportDate(value: string): string | null {
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const uk = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (uk) [day, month, year] = [Number(uk[1]), Number(uk[2]), Number(uk[3].length === 2 ? `20${uk[3]}` : uk[3])];
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Split a list cell ("Electrical; Plumbing") into trimmed, de-duplicated values. */
export function splitListCell(value: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const part of value.split(/[;|,]/)) {
    const item = part.trim();
    if (item && !seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      items.push(item);
    }
  }
  return items;
}

// Characters a spreadsheet may skip before deciding a cell is a formula
// (whitespace, BOM, C0/C1 controls, zero-width), matching the web app's csv.ts.
const LEADING_IGNORABLE = /^[\s\u0000-\u001F\u007F-\u009F​-‍⁠﻿]*/;
const FORMULA_TRIGGER = /^[=+\-@＝＋－＠]/;

/**
 * One quoted CSV field, neutralised against spreadsheet formula injection
 * (OWASP "CSV Injection"): a value whose first meaningful character is
 * = + - @, or which starts with a tab or carriage return, gets a leading
 * single quote so spreadsheets show it as text.
 */
export function csvCell(value: string): string {
  const neutralised = /^[\t\r]/.test(value) || FORMULA_TRIGGER.test(value.replace(LEADING_IGNORABLE, ""))
    ? `'${value}`
    : value;
  return `"${neutralised.replace(/"/g, '""')}"`;
}

/** Downloadable template: the header row plus one example row. */
export function importTemplateCsv(type: CsvImportType): string {
  const columns = CSV_IMPORT_COLUMNS[type];
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const example = columns.map((column) => csvCell(column.example)).join(",");
  return `﻿${header}\r\n${example}\r\n`;
}
