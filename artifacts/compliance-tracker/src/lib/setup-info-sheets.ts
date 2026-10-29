/**
 * "What we need from you" Excel workbooks offered on the setup wizard's
 * getting-started page: one per track, each a Read me tab plus one tab per
 * list to gather. Tabs marked `importsInto` use exactly the headers of that
 * track's "Import spreadsheet" template (api-server lib/csvImport.ts, the
 * staff roster and GreenTrack equipment templates), so a filled-in tab can be
 * uploaded as it is; keep them in step when an import template changes.
 */

export const SETUP_SERVICE_FEE = "£500 + VAT";

export type InfoSheetTab = {
  name: string;
  /** What to put on this tab, shown on the Read me tab. */
  about: string;
  /** Where a filled-in tab can be uploaded; otherwise it is typed in (or sent to ALPS). */
  importsInto?: string;
  headers: string[];
  /** Example or starter rows (an example row is replaced by your own). */
  rows: string[][];
};

export type InfoSheet = { key: string; label: string; about: string; tabs: InfoSheetTab[] };

const CONTRACTOR_HEADERS = ["Contact name", "Company", "Email", "Phone", "Address", "Trades", "Gas Safe number", "Public liability expiry", "Notes"];

/**
 * The contractor services on the Contractors page's "Contractor inspections
 * and visits" card (api-server lib/contractorVisits.ts CONTRACTOR_VISIT_TYPES,
 * labels kept the same) plus the usual Compliance Checks done by contractors.
 * Trade is the stored trade code written out, which the contractor import accepts.
 */
const CONTRACTOR_SERVICES: [track: string, service: string, trade: string][] = [
  ["Compliance Checks", "Gas safety certificate", "Gas Heating"],
  ["Compliance Checks", "Kitchen gas appliance service", "Gas Kitchen"],
  ["Compliance Checks", "Boiler service", "Gas Heating"],
  ["Compliance Checks", "Electrical installation (EICR)", "Electrical"],
  ["Compliance Checks", "Lift thorough examination (LOLER)", "Loler Puwer Inspection"],
  ["Compliance Checks", "Asbestos management survey", "Asbestos"],
  ["Compliance Checks", "Air conditioning service", "Hvac"],
  ["Compliance Checks", "Waste collection", "Waste Collection"],
  ["FireTrack", "Fire alarm service (6-monthly)", "Fire Alarm"],
  ["FireTrack", "Fire extinguisher service (annual)", "Fire Extinguishers"],
  ["FireTrack", "Emergency lighting 3-hour test (annual)", "Emergency Lighting"],
  ["FireTrack", "Fire risk assessment review", "Fire Risk Assessor"],
  ["FireTrack", "Kitchen fire suppression service (6-monthly)", "Kitchen Fire Suppression"],
  ["FireTrack", "Kitchen extract (duct) cleaning", "Kitchen Extract Cleaning"],
  ["FireTrack", "Sprinkler system service (quarterly)", "Sprinkler Systems"],
  ["FireTrack", "AOV / smoke vent service (annual)", "Aov Smoke Vents"],
  ["FireTrack", "Dry / wet riser inspection (6-monthly)", "Dry Wet Risers"],
  ["FireTrack", "Fire door inspection (6-monthly)", "Fire Doors"],
  ["FireTrack", "Fire shutter / curtain service (annual)", "Fire Shutters Curtains"],
  ["FireTrack", "Fire damper drop test (annual)", "Fire Dampers"],
  ["FireTrack", "Fire stopping survey (annual)", "Fire Stopping"],
  ["FireTrack", "Intruder alarm service (annual)", "Intruder Alarm"],
  ["FireTrack", "CCTV service (annual)", "Cctv"],
  ["FireTrack", "Access control / door entry service (annual)", "Access Control"],
  ["LegionellaTrack", "Legionella risk assessment review", "Legionella Water Hygiene"],
  ["LegionellaTrack", "Legionella water sampling (laboratory)", "Legionella Water Hygiene"],
  ["LegionellaTrack", "Cold water tank clean and disinfect", "Legionella Water Hygiene"],
  ["LegionellaTrack", "Calorifier internal inspection", "Legionella Water Hygiene"],
  ["LegionellaTrack", "Calorifier clean and disinfect", "Legionella Water Hygiene"],
  ["LegionellaTrack", "Thermostatic mixing valve (TMV) service", "Plumbing"],
  ["PestTrack", "Routine pest control visit", "Pest Control"],
  ["PATtrack", "PAT testing visit", "Pat Testing"],
  ["GreenTrack", "Machine servicing", "Equipment"],
  ["GreenTrack", "PUWER inspection", "Loler Puwer Inspection"],
  ["GreenTrack", "LOLER thorough examination, 6-monthly (e.g. vehicle lift)", "Loler Puwer Inspection"],
  ["GreenTrack", "LOLER thorough examination, annual (e.g. axle stands)", "Loler Puwer Inspection"],
  ["GreenTrack", "NSTS sprayer test", "Equipment"],
  ["GreenTrack", "Other statutory inspections (annual, periodic and other)", "Loler Puwer Inspection"],
  ["COSHHTrack", "Local exhaust ventilation (LEV) thorough examination", "Lev Testing"],
  ["TreeTrack", "Annual tree survey (arborist)", "Tree Surgeon Arborist"],
  ["TubTrack", "Spa microbiological test (laboratory)", "Pool Spa Maintenance"],
  ["BikeTrack", "Bike servicing", "Equipment"],
];

const serviceDates = (items: string[]): string[][] => items.map((item) => [item, "", "", "", "", ""]);
const SERVICE_DATE_HEADERS = ["Check", "Site", "Last done (dd/mm/yyyy)", "Done by (contractor or person)", "Certificate or report held? (Yes/No)", "Notes"];

export const INFO_SHEETS: InfoSheet[] = [
  {
    key: "getting-started",
    label: "Getting started (every business)",
    about: "Your sites, departments and the people who will use ComplyTrack. Fill this in first.",
    tabs: [
      {
        name: "Sites", about: "One line per premises.",
        headers: ["Site name", "Address", "Postcode", "Main contact", "Phone"],
        rows: [["Main building", "1 High Street, Anytown", "AB1 2CD", "Jane Smith", "01234 567890"]],
      },
      {
        name: "Departments", about: "The teams at each site, for example Kitchen, Housekeeping, Greenkeeping, Maintenance.",
        headers: ["Site", "Department"],
        rows: [["Main building", "Kitchen"], ["Main building", "Housekeeping"]],
      },
      {
        name: "Logins", about: "Everyone who will sign in. Owners see billing; Managers look after one or more departments; Staff record checks for their own department; Viewers only sign their own training.",
        headers: ["Name", "Email", "Role (Owner, Manager, Staff or Viewer)", "Site", "Department(s)"],
        rows: [["Jane Smith", "jane.smith@example.com", "Manager", "Main building", "Kitchen, Housekeeping"]],
      },
      {
        name: "Staff roster", about: "All other staff, for training records and sign-offs. They don't need a login.",
        importsInto: "Staff Roster > Import spreadsheet",
        headers: ["Payroll ID", "Name", "Job Title", "Department", "Email"],
        rows: [["1001", "Jane Smith", "Chef de partie", "Kitchen", "jane.smith@example.com"]],
      },
    ],
  },
  {
    key: "contractors",
    label: "Contractors",
    about: "Everyone who services, inspects or repairs for you, and which contractor does each service on each track.",
    tabs: [
      {
        name: "Contractors", about: "One line per contractor. Trades are the words in the Trade column of the next tab; separate several with ;. Gas Safe number for gas engineers only.",
        importsInto: "Contractors > Import spreadsheet",
        headers: CONTRACTOR_HEADERS,
        rows: [["Sam Patel", "Patel Electrical Ltd", "sam@example.co.uk", "01234 567890", "", "Electrical", "", "31/03/2027", ""]],
      },
      {
        name: "Services by track", about: "Every contractor service ComplyTrack tracks. Put the company that does it, or N/A if you don't need it. Delete the tracks you don't use.",
        headers: ["Track", "Contractor service", "Trade", "Contractor company (or N/A)", "Last visit (dd/mm/yyyy)"],
        rows: CONTRACTOR_SERVICES.map(([track, service, trade]) => [track, service, trade, "", ""]),
      },
    ],
  },
  {
    key: "compliance",
    label: "Compliance Checks",
    about: "When your servicing, inspections and certificates were last done. ComplyTrack works out when each is next due.",
    tabs: [
      {
        name: "Service dates", about: "Fill in the ones that apply and delete the rest. Add any others on new lines. With AI features on, ComplyTrack can also read the dates from the certificates themselves.",
        headers: SERVICE_DATE_HEADERS,
        rows: serviceDates([
          "Fire risk assessment", "Fire alarm service", "Emergency lighting service", "Fire extinguisher service",
          "Electrical installation (EICR)", "Portable appliance testing (PAT)", "Gas safety certificate", "Boiler service",
          "Oil boiler / tank service", "Legionella risk assessment", "Asbestos management survey", "Lift thorough examination (LOLER)",
          "Kitchen extraction / ductwork clean", "Air conditioning inspection", "Lightning protection test",
          "Employers' liability insurance", "Public liability insurance", "Waste transfer note", "Waste carrier registration",
        ]),
      },
      {
        name: "Asbestos register", about: "From your asbestos survey. Leave blank if the building was built after 2000.",
        headers: ["Site", "Location", "Material", "Condition", "Risk score", "Action", "Last inspected (dd/mm/yyyy)", "Notes"],
        rows: [["Main building", "Boiler room ceiling", "Asbestos insulating board", "Good", "Low", "Manage and re-inspect yearly", "", ""]],
      },
    ],
  },
  {
    key: "firetrack",
    label: "FireTrack",
    about: "Fire alarm call points, fire equipment and fire safety service dates.",
    tabs: [
      {
        name: "Call points", about: "Every manual call point, in the order you test them.",
        importsInto: "FireTrack > Call points > Import spreadsheet",
        headers: ["Call point", "Location", "Site"],
        rows: [["CP1", "Reception, main entrance", ""]],
      },
      {
        name: "Fire equipment", about: "Extinguishers, fire blankets, emergency lights, fire doors and alarm panels.",
        headers: ["Item (extinguisher, blanket, emergency light, fire door, alarm panel)", "Reference", "Type (e.g. CO2, foam)", "Location", "Site", "Last serviced (dd/mm/yyyy)"],
        rows: [["Extinguisher", "EX1", "CO2 2kg", "Kitchen door", "Main building", ""]],
      },
      {
        name: "Service dates", about: "When each was last done and by whom.",
        headers: SERVICE_DATE_HEADERS,
        rows: serviceDates(["Fire risk assessment", "Fire alarm service", "Emergency lighting service", "Fire extinguisher service", "Last fire drill"]),
      },
    ],
  },
  {
    key: "kitchentrack",
    label: "KitchenTrack",
    about: "Fridges and freezers, probes, cleaning schedule and allergen information.",
    tabs: [
      {
        name: "Fridges and freezers", about: "Every unit you take a temperature from, including hot holding.",
        headers: ["Name", "Type (fridge, freezer, display, hot hold)", "Site", "Location"],
        rows: [["Fridge 1", "Fridge", "Main building", "Main kitchen"]],
      },
      {
        name: "Probes", about: "Temperature probes and when they were last checked.",
        headers: ["Probe name or number", "Site", "Last calibrated (dd/mm/yyyy)"],
        rows: [["Probe 1", "Main building", ""]],
      },
      {
        name: "Cleaning schedule", about: "What is cleaned, how often and by whom.",
        headers: ["Area", "Task", "Frequency (daily, weekly, monthly)", "Method", "Product", "Responsible"],
        rows: [["Main kitchen", "Clean extraction canopy filters", "Weekly", "Soak in degreaser", "Degreaser", "Kitchen porter"]],
      },
      {
        name: "Dishes", about: "Each dish on the menu and its 14 allergens, for the allergen charts.",
        headers: ["Dish", "Description", "Contains (allergens)", "May contain", "Site"],
        rows: [["Fish and chips", "Battered cod, chips, peas", "Fish, Gluten", "", "Main building"]],
      },
      {
        name: "Ingredients", about: "Bought-in ingredients and their allergens.",
        headers: ["Ingredient", "Supplier", "Product code", "Contains (allergens)", "May contain"],
        rows: [["Batter mix", "Brakes", "12345", "Gluten", ""]],
      },
      {
        name: "Documents", about: "Have these to upload.",
        headers: ["Document", "Held? (Yes/No)", "Date", "Notes"],
        rows: [["HACCP / food safety plan", "", "", ""], ["Food hygiene rating", "", "", ""], ["Staff food hygiene certificates", "", "", ""], ["Recipe or specification sheets", "", "", ""]],
      },
    ],
  },
  {
    key: "legionellatrack",
    label: "LegionellaTrack",
    about: "The water outlets you test and flush, from your legionella risk assessment.",
    tabs: [
      {
        name: "Outlets", about: "Sentinel outlets (nearest and furthest from the tank or heater), little-used outlets, showers and calorifiers.",
        headers: ["Outlet name", "Type (sentinel hot, sentinel cold, little-used, shower, calorifier, cold tank)", "Location", "Site"],
        rows: [["Room 12 basin hot", "Sentinel hot", "First floor, room 12", "Main building"]],
      },
      {
        name: "Service dates", about: "Your risk assessment and any water treatment visits.",
        headers: SERVICE_DATE_HEADERS,
        rows: serviceDates(["Legionella risk assessment", "Water tank inspection / clean", "Shower head descale", "Water treatment contractor visit"]),
      },
    ],
  },
  {
    key: "pattrack",
    label: "PATtrack",
    about: "Your portable electrical appliances.",
    tabs: [
      {
        name: "Appliances", about: "One line per appliance. The asset tag is the label number if there is one.",
        importsInto: "PATtrack > Import spreadsheet",
        headers: ["Appliance name", "Asset tag", "Appliance type", "Site", "Location", "Notes"],
        rows: [["Kettle", "PAT-0001", "Kitchen Appliance", "Main building", "Staff kitchen", ""]],
      },
      {
        name: "Last test", about: "Your most recent PAT test, from the certificate.",
        headers: SERVICE_DATE_HEADERS,
        rows: serviceDates(["Portable appliance testing (PAT)"]),
      },
    ],
  },
  {
    key: "roomtrack",
    label: "RoomTrack",
    about: "The rooms you check.",
    tabs: [
      {
        name: "Rooms", about: "One line per room.",
        importsInto: "RoomTrack > Import spreadsheet",
        headers: ["Room number", "Room name", "Floor", "Site", "Notes"],
        rows: [["101", "Garden suite", "Ground", "Main building", ""]],
      },
    ],
  },
  {
    key: "greentrack",
    label: "GreenTrack",
    about: "Grounds machinery, spraying products and operators.",
    tabs: [
      {
        name: "Equipment", about: "Every machine. Type is, for example, greens mower - ride on, greens mower - hand, fairway, ride-on, pedestrian, tractor, utility or other. Active is true or false.",
        importsInto: "GreenTrack > Equipment > Import spreadsheet",
        headers: ["name", "type", "make", "model", "serial_no", "reg_no", "year", "site", "notes", "active"],
        rows: [
          ["Greens mower 1", "greens mower - ride on", "Toro", "Greensmaster 3150", "GM-001", "GT-01", "2021", "", "Triple greens mower", "true"],
          ["Greens mower 2", "greens mower - hand", "Toro", "Greensmaster 1000", "GM-002", "GT-02", "2022", "", "Hand greens mower", "true"],
        ],
      },
      {
        name: "Products and stock", about: "Fertilisers, pesticides and fuel you keep, with how much you have now.",
        headers: ["Product name", "Category (pesticide, fertiliser, fuel, other)", "Unit (L, kg)", "MAPP number", "Active ingredient", "Supplier", "Amount in stock now", "Reorder level"],
        rows: [["Example herbicide", "Pesticide", "L", "12345", "Glyphosate", "Supplier Ltd", "20", "5"]],
      },
      {
        name: "Operators", about: "Who sprays and their certificates.",
        headers: ["Name", "Certificate (PA1, PA2, PA6)", "Certificate number", "Expiry (dd/mm/yyyy)"],
        rows: [["Alex Brown", "PA1, PA2", "", ""]],
      },
    ],
  },
  {
    key: "coshhtrack",
    label: "COSHHTrack",
    about: "Hazardous substances you use, for your COSHH register and assessments.",
    tabs: [
      {
        name: "Substances", about: "One line per product. Have the safety data sheet (SDS) for each to upload.",
        headers: ["Product name", "Supplier", "Where used", "Hazard symbols", "Safety data sheet held? (Yes/No)", "Site"],
        rows: [["Oven cleaner", "Supplier Ltd", "Main kitchen", "Corrosive", "Yes", "Main building"]],
      },
    ],
  },
  {
    key: "traintrack",
    label: "TrainTrack",
    about: "Staff training already completed, so expiry reminders start straight away.",
    tabs: [
      {
        name: "Training records", about: "One line per person per course. Names should match the staff roster.",
        headers: ["Staff name", "Training", "Provider", "Completed (dd/mm/yyyy)", "Expires (dd/mm/yyyy)", "Notes"],
        rows: [["Jane Smith", "Level 2 Food Hygiene", "Highfield", "", "", ""]],
      },
      {
        name: "Training needed", about: "Which training each job needs and how often.",
        headers: ["Job title or department", "Training", "Repeat every (months)"],
        rows: [["Kitchen", "Level 2 Food Hygiene", "36"]],
      },
    ],
  },
  {
    key: "doctrack",
    label: "DocTrack",
    about: "Policies, risk assessments and procedures, and who must read and sign them.",
    tabs: [
      {
        name: "Documents", about: "Have each one to upload.",
        headers: ["Document title", "Type (policy, risk assessment, procedure, method statement)", "Date of current version (dd/mm/yyyy)", "Review due (dd/mm/yyyy)", "Who must read and sign (departments)"],
        rows: [["Health and safety policy", "Policy", "", "", "Everyone"]],
      },
    ],
  },
  {
    key: "fixtrack",
    label: "FixTrack",
    about: "Repairs that are already waiting, so nothing is lost when you start.",
    tabs: [
      {
        name: "Open repairs", about: "Anything reported but not yet fixed.",
        headers: ["What is wrong", "Site", "Location", "Priority (low, medium, high, urgent)", "Reported (dd/mm/yyyy)", "Contractor (if booked)"],
        rows: [["Dripping tap", "Main building", "Ladies toilets", "Low", "", ""]],
      },
    ],
  },
  {
    key: "incidenttrack",
    label: "IncidentTrack",
    about: "First aiders and recent incidents.",
    tabs: [
      {
        name: "First aiders", about: "Who is trained and when it runs out.",
        headers: ["Name", "Site", "Certificate (e.g. First Aid at Work)", "Expires (dd/mm/yyyy)"],
        rows: [["Jane Smith", "Main building", "Emergency First Aid at Work", ""]],
      },
      {
        name: "Recent incidents", about: "Accidents in the last 12 months, if you want them on record.",
        headers: ["Date (dd/mm/yyyy)", "Site", "What happened", "Person (staff, guest, contractor)", "Reported to HSE under RIDDOR? (Yes/No)"],
        rows: [["", "", "", "", ""]],
      },
    ],
  },
  {
    key: "pesttrack",
    label: "PestTrack",
    about: "Your pest control contract and bait points.",
    tabs: [
      {
        name: "Pest contract", about: "From your pest control contract. The pest contractor's details go on the Contractors spreadsheet.",
        headers: ["Visits per year", "Contract renewal (dd/mm/yyyy)"],
        rows: [["", ""]],
      },
      {
        name: "Bait points", about: "From the site plan your pest contractor left.",
        headers: ["Reference", "Type (bait box, fly killer, monitor)", "Location", "Site"],
        rows: [["B1", "Bait box", "Bin store", "Main building"]],
      },
    ],
  },
  {
    key: "premisestrack",
    label: "PremisesTrack",
    about: "The areas you inspect around your premises.",
    tabs: [
      {
        name: "Areas", about: "One line per area to inspect.",
        headers: ["Area", "Site", "How often (daily, weekly, monthly)", "Responsible"],
        rows: [["Car park", "Main building", "Weekly", "Maintenance"]],
      },
    ],
  },
  {
    key: "hottubtrack",
    label: "TubTrack",
    about: "Your hot tubs and how they are treated.",
    tabs: [
      {
        name: "Hot tubs", about: "One line per hot tub.",
        headers: ["Name", "Site", "Description", "Disinfectant (chlorine, bromine)", "Last drained and cleaned (dd/mm/yyyy)"],
        rows: [["Lodge 4 hot tub", "Main building", "6 seat", "Chlorine", ""]],
      },
    ],
  },
  {
    key: "aquatrack",
    label: "AquaTrack",
    about: "Your pools and their water treatment.",
    tabs: [
      {
        name: "Pools", about: "One line per pool or spa.",
        headers: ["Name", "Site", "Type (pool, spa, splash pad)", "Volume (litres)", "Disinfectant", "Target free chlorine (mg/l)", "Target pH"],
        rows: [["Main pool", "Main building", "Pool", "250000", "Chlorine", "1.0 - 2.0", "7.2 - 7.4"]],
      },
    ],
  },
  {
    key: "treetrack",
    label: "TreeTrack",
    about: "Trees or tree areas that need inspecting.",
    tabs: [
      {
        name: "Trees", about: "From your last tree survey.",
        headers: ["Tree or area reference", "Species", "Location", "Site", "Last inspected (dd/mm/yyyy)", "Inspected by", "Next inspection (dd/mm/yyyy)"],
        rows: [["T1", "Oak", "Beside 1st tee", "Main building", "", "", ""]],
      },
    ],
  },
  {
    key: "biketrack",
    label: "BikeTrack",
    about: "Your hire bikes.",
    tabs: [
      {
        name: "Bikes", about: "One line per bike.",
        headers: ["Reference", "Name", "Type (adult, child, e-bike, tandem)", "Site", "Last serviced (dd/mm/yyyy)", "Notes"],
        rows: [["B01", "Blue Raleigh", "Adult", "Main building", "", ""]],
      },
    ],
  },
  {
    key: "dailytrack",
    label: "DailyTrack (opening and closing checks)",
    about: "The checks each team does when opening and closing.",
    tabs: [
      {
        name: "Daily checks", about: "One line per check. Opening or closing, and which team does it.",
        headers: ["Site", "Team or department", "Opening or closing", "Check"],
        rows: [["Main building", "Front of house", "Opening", "Fire exits clear and unlocked"], ["Main building", "Kitchen", "Closing", "Gas turned off at the isolator"]],
      },
    ],
  },
];

/** The Read me tab: what each tab is for and how it gets into ComplyTrack. */
export function readMeRows(sheet: InfoSheet): string[][] {
  return [
    [`ComplyTrack: ${sheet.label}`],
    [sheet.about],
    [],
    ["Tab", "What to fill in", "How it gets into ComplyTrack"],
    ...sheet.tabs.map((tab) => [tab.name, tab.about, tab.importsInto ? `Upload this whole workbook at ${tab.importsInto}; it reads this tab` : "Type it in, or send it to ALPS"]),
    [],
    ["The first line on each tab is an example: replace it with your own. Leave out anything you don't have yet; it can be added later."],
    [`Short of time? ALPS can enter all of this for you for a one-off ${SETUP_SERVICE_FEE}. Ask from Set up > Before you get started.`],
  ];
}

export async function downloadInfoSheet(sheet: InfoSheet) {
  const { downloadWorkbook } = await import("@/lib/spreadsheet");
  downloadWorkbook(`complytrack-${sheet.key}-information.xlsx`, [
    { name: "Read me", rows: readMeRows(sheet) },
    ...sheet.tabs.map((tab) => ({ name: tab.name, rows: [tab.headers, ...tab.rows] })),
  ]);
}
