/**
 * The lists "Upload your lists" can sort a file into, and how a spreadsheet
 * is sorted in the browser: by its column headings (the same ones each import
 * reads), with the file name as a tie-breaker. Photos, scans and PDFs are
 * sorted by AI instead (POST /imports/sort-list).
 */

export type ListKind = "pat-appliances" | "room-track-rooms" | "contractors" | "fire-call-points" | "greentrack-equipment" | "staff-roster" | "legionella-outlets";

/**
 * The tab each list has in the setup wizard's "What we need from you"
 * workbooks (src/lib/setup-info-sheets.ts); its import reads that tab.
 */
export const WORKBOOK_TABS: Record<ListKind, string> = {
  "pat-appliances": "Appliances",
  "room-track-rooms": "Rooms",
  contractors: "Contractors",
  "fire-call-points": "Call points",
  "greentrack-equipment": "Equipment",
  "staff-roster": "Staff roster",
  "legionella-outlets": "Outlets and tanks",
};

export const LIST_KINDS: Record<ListKind, { label: string; noun: string; service: string | null; headings: string[]; fileName: RegExp }> = {
  "pat-appliances": {
    label: "PATTrack appliances",
    noun: "PAT appliances",
    service: "pattrack",
    headings: ["assettag", "assetno", "assetnumber", "assetid", "appliance", "appliancename", "appliancetype", "pat", "pattest", "lastpattest"],
    fileName: /\b(pat|appliances?)\b/i,
  },
  "room-track-rooms": {
    label: "RoomTrack rooms",
    noun: "rooms",
    service: "roomtrack",
    headings: ["roomnumber", "roomno", "roomname", "roomref", "floor", "level", "storey"],
    fileName: /\brooms?\b/i,
  },
  contractors: {
    label: "Contractors",
    noun: "contractors",
    service: null,
    headings: ["contactname", "contact", "company", "companyname", "business", "organisation", "organization", "trades", "trade", "gassafe", "gassafenumber", "gassafeno", "publicliability", "publicliabilityexpiry", "plexpiry", "insuranceexpiry", "telephone", "phone", "tel", "address"],
    fileName: /contractor|supplier|trades/i,
  },
  "fire-call-points": {
    label: "FireTrack call points",
    noun: "fire alarm call points",
    service: "firetrack",
    headings: ["callpoint", "callpointname", "callpointref", "callpointreference", "callpointnumber", "callpointno", "cp", "cpno", "cpnumber", "cpref", "zone"],
    fileName: /call ?points?|fire ?alarm/i,
  },
  "greentrack-equipment": {
    label: "GreenTrack equipment",
    noun: "greenkeeping machines",
    service: "greentrack",
    headings: ["machine", "machinename", "machinetype", "equipmenttype", "make", "manufacturer", "model", "serial", "serialno", "serialnumber", "fleetno", "fleetnumber", "regno", "registration", "year", "manufactureyear"],
    fileName: /machine|mower|fleet|green|equipment/i,
  },
  "staff-roster": {
    label: "Staff roster",
    noun: "staff",
    service: null,
    headings: ["payrollid", "payrollno", "payrollnumber", "employeeid", "staffid", "workforceid", "employeename", "staffname", "jobtitle", "role", "position", "department", "dept", "team"],
    fileName: /staff|roster|employee|team|people/i,
  },
  "legionella-outlets": {
    label: "LegionellaTrack outlets and tanks",
    noun: "water outlets and tanks",
    service: "legionellatrack",
    headings: ["outletortank", "outlet", "outletname", "outlettype", "sentinel", "sentineloutlet", "outletref", "tank", "tankname", "hotorcold", "hotcold"],
    fileName: /outlets?|sentinel|legionella|water|tanks?/i,
  },
};

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The kinds this business can import into, in menu order. */
export function availableListKinds(hasService: (key: string) => boolean): ListKind[] {
  return (Object.keys(LIST_KINDS) as ListKind[]).filter(kind => {
    const service = LIST_KINDS[kind].service;
    return service === null || hasService(service);
  });
}

/**
 * The list a spreadsheet most likely is, from its headings (two points each)
 * and its file name (one point), or null when no kind clearly wins.
 */
export function guessListKind(headers: string[], fileName: string, kinds: ListKind[]): ListKind | null {
  const headings = headers.map(normalise).filter(Boolean);
  const scores = kinds.map(kind => ({
    kind,
    score: headings.filter(heading => LIST_KINDS[kind].headings.includes(heading)).length * 2
      + (LIST_KINDS[kind].fileName.test(fileName.replace(/[_.-]+/g, " ")) ? 1 : 0),
  })).sort((a, b) => b.score - a.score);
  const [best, next] = scores;
  return best && best.score >= 2 && best.score > (next?.score ?? 0) ? best.kind : null;
}

/** The list a photo or PDF most likely is from its file name alone, when only one kind matches. */
export function guessListKindFromName(fileName: string, kinds: ListKind[]): ListKind | null {
  const name = fileName.replace(/[_.-]+/g, " ");
  const matches = kinds.filter(kind => LIST_KINDS[kind].fileName.test(name));
  return matches.length === 1 ? matches[0] : null;
}
