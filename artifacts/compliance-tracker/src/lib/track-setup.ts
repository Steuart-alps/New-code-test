/**
 * Setting tracks up from the setup wizard's "What we need from you"
 * workbooks (src/lib/setup-info-sheets.ts): the KitchenTrack fridges and
 * freezers, LegionellaTrack outlets, TubTrack hot tubs and BikeTrack bikes a
 * workbook lists by name, or the numbers on its "Counts per site" tab
 * (10 fridges become Fridge 1 to Fridge 10). Fire alarm call points counted
 * there become CP1, CP2 and so on. This file only plans; the "Upload your
 * lists" page shows the plan and adds what is ticked through each track's
 * usual API.
 */

export type TrackSetupKind = "cold-units" | "outlets" | "hot-tubs" | "bikes" | "call-points";

export const TRACK_SETUP: Record<TrackSetupKind, { label: string; service: string; noun: string }> = {
  "cold-units": { label: "KitchenTrack fridges and freezers", service: "kitchentrack", noun: "fridges and freezers" },
  outlets: { label: "LegionellaTrack outlets", service: "legionellatrack", noun: "outlets" },
  "hot-tubs": { label: "TubTrack hot tubs", service: "hottubtrack", noun: "hot tubs" },
  bikes: { label: "BikeTrack bikes", service: "biketrack", noun: "bikes" },
  "call-points": { label: "FireTrack call points", service: "firetrack", noun: "call points" },
};

/** The workbook tabs a track is set up from (each track's own list tab, and the counts). */
export const TRACK_SETUP_TABS: Record<string, TrackSetupKind | "counts"> = {
  "fridges and freezers": "cold-units",
  outlets: "outlets",
  "hot tubs": "hot-tubs",
  bikes: "bikes",
  "counts per site": "counts",
};

export type OutletType = "hot" | "cold" | "calorifier" | "tmv" | "little_used";

export type PlannedItem = {
  name: string;
  /** Fridge or freezer, outlet type or bike type. */
  type?: string;
  location?: string;
  description?: string;
};

/** One track's items at one site (siteName null: the whole business). */
export type PlanGroup = {
  kind: TrackSetupKind;
  siteName: string | null;
  items: PlannedItem[];
  /** "list": named on the track's tab; "count": numbered from Counts per site. */
  source: "list" | "count";
};

export type TrackSetupPlan = { groups: PlanGroup[]; skipped: string[] };

const normalise = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The column whose heading starts with one of `names` (headings carry hints such as "Type (fridge or freezer)"). */
function column(headers: string[], ...names: string[]): number {
  return headers.findIndex((header) => names.some((name) => normalise(header) === name || normalise(header).startsWith(`${name} `)));
}

function cell(row: string[], index: number): string {
  return index < 0 ? "" : String(row[index] ?? "").trim();
}

function addToGroup(groups: PlanGroup[], kind: TrackSetupKind, siteName: string | null, source: PlanGroup["source"], item: PlannedItem) {
  const site = siteName?.trim() || null;
  let group = groups.find((g) => g.kind === kind && g.source === source && (g.siteName ?? "").toLowerCase() === (site ?? "").toLowerCase());
  if (!group) {
    group = { kind, siteName: site, items: [], source };
    groups.push(group);
  }
  if (!group.items.some((existing) => existing.name.toLowerCase() === item.name.toLowerCase())) group.items.push(item);
}

const OUTLET_TYPES: Record<string, OutletType> = {
  hot: "hot", "sentinel hot": "hot", "hot sentinel": "hot",
  cold: "cold", "sentinel cold": "cold", "cold sentinel": "cold",
  calorifier: "calorifier", "hot water cylinder": "calorifier",
  tmv: "tmv", "thermostatic mixing valve": "tmv",
  "little used": "little_used", "little used outlet": "little_used", shower: "little_used",
};

/** A track's own list tab: one item per named line. */
export function planFromListTab(kind: TrackSetupKind, headers: string[], rows: string[][], skipped: string[]): PlanGroup[] {
  const groups: PlanGroup[] = [];
  const name = column(headers, "name", "outlet name", "reference", "call point");
  const type = column(headers, "type");
  const site = column(headers, "site");
  const location = column(headers, "location");
  const description = column(headers, "description");
  const bikeName = kind === "bikes" ? column(headers, "name") : -1;
  const bikeRef = kind === "bikes" ? column(headers, "reference", "ref") : -1;
  for (const row of rows) {
    const label = kind === "bikes" ? cell(row, bikeRef) : cell(row, name);
    if (!label) continue;
    const siteName = cell(row, site) || null;
    if (kind === "cold-units") {
      const raw = normalise(cell(row, type));
      const unitType = raw.includes("freez") ? "freezer" : raw === "" || raw.includes("fridge") || raw.includes("display") || raw.includes("chiller") ? "fridge" : null;
      if (!unitType) { skipped.push(`${label}: only fridges and freezers are KitchenTrack units ("${cell(row, type)}" left out)`); continue; }
      addToGroup(groups, kind, siteName, "list", { name: label.slice(0, 40), type: unitType });
    } else if (kind === "outlets") {
      const outletType = OUTLET_TYPES[normalise(cell(row, type))];
      if (!outletType) { skipped.push(`${label}: outlet type "${cell(row, type)}" isn't hot, cold, calorifier, TMV or little-used`); continue; }
      addToGroup(groups, kind, siteName, "list", { name: label, type: outletType, location: cell(row, location) || undefined });
    } else if (kind === "hot-tubs") {
      addToGroup(groups, kind, siteName, "list", { name: label, description: cell(row, description) || undefined });
    } else if (kind === "bikes") {
      addToGroup(groups, kind, siteName, "list", { name: label, description: cell(row, bikeName) || undefined, type: cell(row, type).toLowerCase().replace(/[^a-z]/g, "") || undefined });
    }
  }
  return groups;
}

/** Counted items on the "Counts per site" tab: Item heading → what each one becomes. */
const COUNTED: Record<string, { kind: TrackSetupKind; name: (n: number) => string; type?: string }> = {
  fridges: { kind: "cold-units", name: (n) => `Fridge ${n}`, type: "fridge" },
  "display fridges or chillers": { kind: "cold-units", name: (n) => `Display fridge ${n}`, type: "fridge" },
  freezers: { kind: "cold-units", name: (n) => `Freezer ${n}`, type: "freezer" },
  "hot tubs": { kind: "hot-tubs", name: (n) => `Hot tub ${n}` },
  "hire bikes": { kind: "bikes", name: (n) => `Bike ${n}` },
  "fire alarm call points": { kind: "call-points", name: (n) => `CP${n}` },
  showers: { kind: "outlets", name: (n) => `Shower ${n}`, type: "little_used" },
};

const MAX_COUNT = 200;

/** "Counts per site": a column per site, numbered items for each count. */
export function planFromCounts(headers: string[], rows: string[][], skipped: string[]): PlanGroup[] {
  const groups: PlanGroup[] = [];
  const item = column(headers, "item");
  const notes = column(headers, "notes");
  if (item < 0) return groups;
  const siteColumns = headers.map((header, index) => ({ header: header.trim(), index }))
    .filter(({ header, index }) => index > item && index !== notes && header);
  for (const row of rows) {
    const counted = COUNTED[normalise(cell(row, item))];
    if (!counted) continue;
    for (const { header, index } of siteColumns) {
      const raw = cell(row, index);
      if (!raw) continue;
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 0 || count > MAX_COUNT) {
        skipped.push(`${cell(row, item)} at ${header}: "${raw}" isn't a number from 0 to ${MAX_COUNT}`);
        continue;
      }
      for (let n = 1; n <= count; n++) {
        addToGroup(groups, counted.kind, header, "count", { name: counted.name(n), ...(counted.type ? { type: counted.type } : {}) });
      }
    }
  }
  return groups;
}

/**
 * The whole plan for a workbook's tabs. A track's named list wins over the
 * counts for the same site, so "Walk-in fridge" isn't added again as "Fridge 3".
 */
export function planTrackSetup(tabs: { name: string; headers: string[]; rows: string[][] }[]): TrackSetupPlan {
  const skipped: string[] = [];
  const listed: PlanGroup[] = [];
  const counted: PlanGroup[] = [];
  for (const tab of tabs) {
    const kind = TRACK_SETUP_TABS[normalise(tab.name)];
    if (!kind) continue;
    if (kind === "counts") counted.push(...planFromCounts(tab.headers, tab.rows, skipped));
    else listed.push(...planFromListTab(kind, tab.headers, tab.rows, skipped));
  }
  const hasList = (group: PlanGroup) => listed.some((other) => other.kind === group.kind && (other.siteName ?? "").toLowerCase() === (group.siteName ?? "").toLowerCase());
  return { groups: [...listed, ...counted.filter((group) => !hasList(group))].filter((group) => group.items.length), skipped };
}

/** "Fridge 1, Fridge 2 … Fridge 10" for a preview line. */
export function describeItems(items: PlannedItem[]): string {
  const names = items.map((item) => item.name);
  return names.length > 6 ? `${names.slice(0, 3).join(", ")} … ${names[names.length - 1]} (${names.length})` : names.join(", ");
}
