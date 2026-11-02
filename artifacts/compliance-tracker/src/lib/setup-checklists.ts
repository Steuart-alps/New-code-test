/**
 * The "Checklist" tab at the front of each setup workbook, laid out like the
 * compliance checklists ALPS clients already keep in Excel: one line per
 * item with its time period, when it was last done, when it is next due, a
 * status, and the contractor's details. Contractor work comes first, then
 * what is done in house. Items follow the contractor services on the
 * Contractors page and each track's own checks; frequencies are the usual
 * ones and can be changed.
 */

/** A text cell, or a formula Excel works out (shown with `format`). */
export type InfoCell = string | { formula: string; format?: string };

/** Column headings, as on the clients' own compliance checklists. */
export const CHECKLIST_HEADERS = ["Item", "Time Period", "Last Completed", "Due Date", "Status", "Contractor", "Telephone Number", "Email Address", "Site", "Notes"];

/** `months` fills Due Date from Last Completed; without it the due date is typed in. */
export type ChecklistItem = { item: string; period: string; months?: number };
export type Checklist = { contractor: ChecklistItem[]; inHouse: ChecklistItem[] };

const annual = (item: string): ChecklistItem => ({ item, period: "Annual", months: 12 });
const sixMonthly = (item: string): ChecklistItem => ({ item, period: "6 monthly", months: 6 });

export const CHECKLISTS: Record<string, Checklist> = {
  compliance: {
    contractor: [
      annual("Heating plant service (gas or oil boilers)"),
      annual("Gas safety certificate"),
      annual("Gas - catering equipment"),
      { item: "Electrical Installation Condition Report (EICR)", period: "5 years", months: 60 },
      annual("Pressure equipment (coffee machine, compressors, shoe cleaner)"),
      { item: "Asbestos management survey", period: "As the survey says (re-inspect annually)" },
      sixMonthly("Passenger or goods lift thorough examination (LOLER)"),
      annual("Air conditioning service"),
      annual("Lightning protection test"),
    ],
    inHouse: [
      annual("Employers' liability insurance"),
      annual("Public liability insurance"),
      annual("Waste transfer note"),
      { item: "Waste carrier registration check", period: "3 years", months: 36 },
    ],
  },
  firetrack: {
    contractor: [
      annual("Fire risk assessment review"),
      sixMonthly("Fire alarm maintenance"),
      annual("Emergency lighting maintenance (3-hour test)"),
      annual("Fire extinguisher maintenance"),
      sixMonthly("Kitchen extraction system clean"),
      sixMonthly("Kitchen fire suppression service"),
      { item: "Sprinkler system service", period: "Quarterly", months: 3 },
      annual("AOV / smoke vent service"),
      sixMonthly("Dry / wet riser inspection"),
      sixMonthly("Fire door inspection"),
      annual("Fire shutter / curtain service"),
      annual("Fire damper drop test"),
      annual("Fire stopping survey"),
      annual("Intruder alarm service"),
      annual("CCTV service"),
      annual("Access control / door entry service"),
    ],
    inHouse: [
      { item: "Fire alarm manual break glass call points", period: "Weekly" },
      { item: "Fire doors", period: "Weekly (at fire alarm test)" },
      { item: "Fire extinguishers", period: "Weekly (at fire alarm test)" },
      { item: "Emergency alarm in disabled toilet working", period: "Weekly" },
      { item: "Emergency lighting", period: "Monthly", months: 1 },
      sixMonthly("Fire drill"),
    ],
  },
  kitchentrack: {
    contractor: [],
    inHouse: [
      { item: "Fridge and freezer temperatures", period: "Twice daily" },
      { item: "Cooking, cooling and reheating temperatures", period: "Each batch" },
      { item: "Hot holding temperatures", period: "Every 2 hours while holding" },
      { item: "Probe calibration", period: "Monthly", months: 1 },
      { item: "Kitchen cleaning schedule", period: "Daily / weekly" },
      { item: "Allergen charts checked", period: "When the menu changes" },
      annual("HACCP / food safety plan review"),
    ],
  },
  legionellatrack: {
    contractor: [
      { item: "Legionella risk assessment", period: "Various (usually 2-5 years)" },
      annual("Legionella water sampling"),
      annual("Disinfection of water tanks"),
      annual("Calorifier inspection and clean"),
      annual("Thermostatic mixing valve (TMV) service"),
    ],
    inHouse: [
      { item: "Little-used outlets flushed", period: "Weekly flushing" },
      { item: "Sentinel outlet temperatures", period: "Monthly temp testing", months: 1 },
      { item: "Shower heads cleaned and disinfected", period: "Quarterly", months: 3 },
    ],
  },
  pattrack: {
    contractor: [annual("Portable appliance testing")],
    inHouse: [{ item: "User checks of appliances and leads", period: "Before use" }],
  },
  roomtrack: {
    contractor: [],
    inHouse: [{ item: "Room checks", period: "After each departure" }],
  },
  greentrack: {
    contractor: [
      annual("Machine servicing"),
      annual("PUWER inspection"),
      sixMonthly("LOLER inspections (front loaders / vehicle lifts)"),
      annual("LOLER inspections (axle stands and other lifting accessories)"),
      { item: "NSTS (Sprayer)", period: "3 years", months: 36 },
    ],
    inHouse: [
      { item: "Machine pre-use checks", period: "Daily" },
      { item: "Spray records", period: "Each application" },
      { item: "Stock and fuel records", period: "As used" },
    ],
  },
  coshhtrack: {
    contractor: [annual("Local exhaust ventilation (LEV) thorough examination")],
    inHouse: [annual("COSHH assessments reviewed"), annual("Safety data sheets up to date")],
  },
  traintrack: {
    contractor: [],
    inHouse: [
      annual("Fire training"),
      { item: "Food hygiene training", period: "3 years", months: 36 },
      { item: "First aid at work", period: "3 years", months: 36 },
      { item: "Manual handling", period: "3 years", months: 36 },
    ],
  },
  doctrack: {
    contractor: [],
    inHouse: [annual("Health and safety policy review"), annual("Risk assessments review")],
  },
  incidenttrack: {
    contractor: [],
    inHouse: [
      { item: "Accident book reviewed", period: "Monthly", months: 1 },
      { item: "First aid kits checked", period: "Monthly", months: 1 },
    ],
  },
  pesttrack: {
    contractor: [{ item: "Routine pest control visit", period: "Quarterly (or as your contract says)", months: 3 }],
    inHouse: [{ item: "Pest activity check", period: "Weekly" }],
  },
  premisestrack: {
    contractor: [],
    inHouse: [{ item: "Premises inspection", period: "Weekly" }],
  },
  hottubtrack: {
    contractor: [{ item: "Spa microbiological test (laboratory)", period: "Quarterly", months: 3 }],
    inHouse: [
      { item: "Water tests (disinfectant and pH)", period: "Several times a day when in use" },
      { item: "Drain, clean and refill", period: "As your risk assessment says" },
    ],
  },
  aquatrack: {
    contractor: [{ item: "Pool microbiological test (laboratory)", period: "Monthly", months: 1 }],
    inHouse: [{ item: "Pool water tests (disinfectant and pH)", period: "Every 2 hours when open" }],
  },
  treetrack: {
    contractor: [annual("Tree survey (arborist)")],
    inHouse: [{ item: "Tree check after high winds", period: "After storms" }],
  },
  biketrack: {
    contractor: [annual("Bike servicing")],
    inHouse: [{ item: "Pre-hire bike check", period: "Before each hire" }],
  },
  dailytrack: {
    contractor: [],
    inHouse: [{ item: "Opening checks", period: "Daily" }, { item: "Closing checks", period: "Daily" }],
  },
};

const PREAMBLE_ROWS = 2;

/** Excel formulas for one line: Due Date from Last Completed (when the period is fixed) and Status. */
function itemRow(entry: ChecklistItem, row: number): InfoCell[] {
  const due = entry.months
    ? { formula: `IF(C${row}="","",EDATE(C${row},${entry.months}))`, format: "dd/mm/yyyy" }
    : "";
  const status = { formula: `IF(D${row}="","",IF(D${row}<TODAY(),"Overdue",IF(D${row}-TODAY()<=30,"Due in "&(D${row}-TODAY())&" days","OK")))` };
  return [entry.item, entry.period, "", due, status, "", "", "", "", ""];
}

/** The checklist tab's title, a note, and its lines (contractor work, then "In-house"). */
export function checklistRows(title: string, checklist: Checklist): { preamble: string[][]; rows: InfoCell[][] } {
  const rows: InfoCell[][] = [];
  // Data starts on the row after the preamble and the heading row (1-based).
  const rowNumber = () => PREAMBLE_ROWS + 2 + rows.length;
  for (const entry of checklist.contractor) rows.push(itemRow(entry, rowNumber()));
  if (checklist.inHouse.length) {
    if (rows.length) rows.push(CHECKLIST_HEADERS.map(() => ""));
    rows.push(["In-house", ...CHECKLIST_HEADERS.slice(1).map(() => "")]);
    for (const entry of checklist.inHouse) rows.push(itemRow(entry, rowNumber()));
  }
  return {
    preamble: [
      [title],
      ["Type Last Completed as dd/mm/yyyy. Due Date fills in where the period is fixed, and Status shows Overdue, Due in … days or OK. Delete lines that don't apply and add your own."],
    ],
    rows,
  };
}
