/**
 * Register CSV imports (PATTrack appliances, RoomTrack rooms, contractors,
 * FireTrack call points, KitchenTrack ingredients from suppliers' allergen
 * information, LegionellaTrack outlets and tanks).
 *
 * Mirrors the staff-roster reconciliation: the browser reads the spreadsheet
 * (Excel or CSV) and sends its header row and cell text; the API maps the
 * headers, validates every row, previews what would happen and only writes
 * when the whole file is valid, in one transaction (routes/csv-imports.ts).
 *
 * Everything in this file is pure so it can be unit tested without a database.
 */
import { PAT_APPLIANCE_TYPES } from "@workspace/db/schema";
import { ALLERGEN_KEYS } from "./allergenRecipes";
import { ALLERGEN_COLUMN_LABELS, ALLERGEN_COLUMN_PREFIXES, allergensInText, parseAllergenCell } from "./allergenImport";

export const CSV_IMPORT_TYPES = ["pat-appliances", "room-track-rooms", "contractors", "fire-call-points", "allergen-ingredients", "legionella-outlets"] as const;
export type CsvImportType = (typeof CSV_IMPORT_TYPES)[number];

export function isCsvImportType(value: unknown): value is CsvImportType {
  return typeof value === "string" && (CSV_IMPORT_TYPES as readonly string[]).includes(value);
}

export const CSV_IMPORT_MAX_ROWS = 1000;
export const CSV_IMPORT_MAX_COLUMNS = 40;
export const CSV_IMPORT_MAX_CELL_LENGTH = 2000;

type ColumnKind = "text" | "email" | "date" | "list" | "allergen";

export interface CsvImportColumn {
  key: string;
  label: string;
  /** Normalised header spellings accepted for this column (see normaliseHeader). */
  aliases: string[];
  /** Also matches a header that starts with one of these (allergen columns). */
  prefixes?: string[];
  /** Accepted but left out of the downloadable template. */
  notInTemplate?: true;
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
  // Suppliers' allergen information: a column per allergen (Y / N / May), or
  // "Contains" and "May contain" lists (lib/allergenImport.ts). A blank Site
  // means the ingredient can be used at every site.
  "allergen-ingredients": [
    { key: "name", label: "Ingredient", aliases: ["ingredient", "ingredientname", "product", "productname", "productdescription", "item", "itemname", "name", "description"], required: true, max: 200, example: "Plain flour" },
    { key: "supplier", label: "Supplier", aliases: ["supplier", "suppliername", "brand", "manufacturer"], max: 200, example: "Brakes" },
    { key: "productCode", label: "Product code", aliases: ["productcode", "code", "sku", "itemcode", "productno", "productnumber", "supplierscode", "suppliercode", "barcode", "ean"], max: 100, example: "FL123" },
    ...ALLERGEN_KEYS.map((key): CsvImportColumn => ({
      key: `allergen_${key}`, label: ALLERGEN_COLUMN_LABELS[key], aliases: [], prefixes: ALLERGEN_COLUMN_PREFIXES[key],
      max: 50, kind: "allergen", example: key === "gluten" ? "Y" : key === "soya" ? "May" : "N",
    })),
    { key: "contains", label: "Contains", aliases: ["contains", "allergens", "containsallergens", "allergenscontained", "allergencontains"], max: 1000, notInTemplate: true, example: "" },
    { key: "mayContain", label: "May contain", aliases: ["maycontain", "maycontaintraces", "traces", "maycontainallergens", "precautionaryallergens", "crosscontamination", "crosscontact"], max: 1000, notInTemplate: true, example: "" },
    { key: "site", label: "Site", aliases: ["site", "sitename"], max: 200, example: "" },
    { key: "notes", label: "Notes", aliases: ["notes", "note", "comments"], max: 2000, example: "" },
  ],
  // Outlets go on the site's monitored outlet list; cold water tanks and
  // calorifiers go on the equipment list, where tank checks name them.
  "legionella-outlets": [
    { key: "name", label: "Outlet or tank", aliases: ["outletortank", "name", "outlet", "outletname", "sentineloutlet", "sentinel", "outletref", "outletreference", "tank", "tankname", "asset", "assetname", "reference", "ref"], required: true, max: 200, example: "Ladies toilets, basin 1" },
    { key: "type", label: "Type", aliases: ["type", "outlettype", "kind", "category", "hotorcold", "hotcold"], required: true, max: 100, example: "Hot" },
    { key: "location", label: "Location", aliases: ["location", "where", "area", "room", "position", "description"], max: 200, example: "Clubhouse ground floor" },
    { key: "site", label: "Site", aliases: ["site", "sitename"], max: 200, example: "" },
  ],
};

export type LegionellaListType = "hot" | "cold" | "tmv" | "little_used" | "cold_water_tank" | "calorifier";
export const LEGIONELLA_LIST_TYPE_WORDS = "Hot, Cold, TMV, Little used, Cold water tank or Calorifier";

/**
 * A LegionellaTrack list's Type cell: an outlet type, or a cold water tank or
 * calorifier (which go on the equipment list). Null when it is not one.
 */
export function legionellaListType(value: string | null | undefined): LegionellaListType | null {
  const v = normaliseHeader(value ?? "");
  if (!v) return null;
  if (/tank|cwst|cistern/.test(v)) return "cold_water_tank";
  if (/calorifier|cylinder/.test(v)) return "calorifier";
  if (/tmv|mix|blend|thermostatic/.test(v)) return "tmv";
  if (/littleused|infrequent|lowuse|rarelyused|seldom|flush/.test(v)) return "little_used";
  if (v.startsWith("hot") || v === "h") return "hot";
  if (v.startsWith("cold") || v === "c") return "cold";
  return null;
}

/** The natural key each register is matched on, for the template help text. */
export const CSV_IMPORT_KEYS: Record<CsvImportType, string> = {
  "pat-appliances": "Asset tag, or appliance name + site + location when there is no asset tag",
  "room-track-rooms": "Site + room number",
  contractors: "Email",
  "fire-call-points": "Site + call point",
  "allergen-ingredients": "Site + ingredient name",
  "legionella-outlets": "Site + name (outlets), or site + name + type (tanks and calorifiers)",
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
  const fileErrors: string[] = [];
  const headerIndex = new Map<string, number>();
  const ignoredHeaders: string[] = [];
  input.headers.forEach((header, index) => {
    const normalised = normaliseHeader(header);
    const column = columns.find((candidate) => candidate.aliases.includes(normalised))
      ?? (normalised ? columns.find((candidate) => candidate.prefixes?.some((prefix) => normalised.startsWith(prefix))) : undefined);
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
  if (type === "allergen-ingredients" && !columns.some((column) => (column.kind === "allergen" || column.key === "contains") && headerIndex.has(column.key))) {
    fileErrors.push("Add the allergen information: a column for each allergen (Y, N or May), or a \"Contains\" column");
  }
  if (input.rows.length > CSV_IMPORT_MAX_ROWS) fileErrors.push(`The file has ${input.rows.length} rows; the maximum is ${CSV_IMPORT_MAX_ROWS}`);
  if (fileErrors.length) return { rows: [], fileErrors, ignoredHeaders };

  const rows: MappedRow[] = [];
  input.rows.forEach((cells, index) => {
    if (cells.every((cell) => !String(cell ?? "").trim())) return; // blank spreadsheet line
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
      if (column.kind === "allergen") {
        const cell = parseAllergenCell(value);
        if (!cell) errors.push(`${column.label} "${value}" is not understood (use Y, N or May)`);
        values[column.key] = cell;
        continue;
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
    if (type === "contractors" && values.email) values.email = values.email.toLowerCase();
    if (type === "allergen-ingredients") {
      // One "contains" and one "may contain" list from the matrix and the
      // list columns together, in the regulated order.
      const contains = new Set<string>();
      const mayContain = new Set<string>();
      for (const key of ALLERGEN_KEYS) {
        const cell = values[`allergen_${key}`];
        if (cell === "contains") contains.add(key);
        if (cell === "may") mayContain.add(key);
      }
      for (const [field, set, label] of [["contains", contains, "Contains"], ["mayContain", mayContain, "May contain"]] as const) {
        const named = allergensInText(values[field] ?? "");
        named.keys.forEach((key) => set.add(key));
        for (const name of named.unknown) errors.push(`${label}: "${name}" is not one of the 14 allergens`);
      }
      // A row with nothing filled in is not "free from all 14": say so.
      const answered = ALLERGEN_KEYS.some((key) => values[`allergen_${key}`] !== null) || values.contains !== null || values.mayContain !== null;
      if (!answered) errors.push("No allergen information on this row: fill in Y, N or May for each allergen, or write None under Contains");
      values.contains = ALLERGEN_KEYS.filter((key) => contains.has(key)).join(";");
      values.mayContain = ALLERGEN_KEYS.filter((key) => mayContain.has(key) && !contains.has(key)).join(";");
    }
    rows.push({ row: index + 2, values, errors });
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
  const columns = CSV_IMPORT_COLUMNS[type].filter((column) => !column.notInTemplate);
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const example = columns.map((column) => csvCell(column.example)).join(",");
  return `﻿${header}\r\n${example}\r\n`;
}
