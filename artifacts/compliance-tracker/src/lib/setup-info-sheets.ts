/**
 * "What we need from you" Excel forms offered on the setup wizard's
 * getting-started page: one per track, kept basic on purpose (Steuart, 2 Nov
 * 2026: "How many fridges / freezers do you have? Which taps are sentinel
 * outlets? Upload list of contractors and what do they do? ... The client can
 * add the detail once they're in the app"). Each workbook is a short Read me,
 * a Questions tab (a number, Yes/No or a few words, one answer column per
 * site) and, only where a list helps, a short list tab. ALPS consultants use
 * the same forms to set a business up.
 *
 * "How many …?" answers set the tracks up when the workbook is uploaded in
 * Upload your lists (src/lib/track-setup.ts: 10 fridges become Fridge 1 to
 * Fridge 10). List tabs marked `importsInto` use headings that import
 * recognises (api-server lib/csvImport.ts, the staff roster and GreenTrack
 * equipment templates), so a filled-in tab uploads as it is.
 */

export const SETUP_SERVICE_FEE = "£500 + VAT";

export type InfoSheetTab = {
  name: string;
  /** What to put on this tab, shown on the Read me tab. */
  about: string;
  /** Where a filled-in tab can be uploaded; otherwise it is typed in (or sent to ALPS). */
  importsInto?: string;
  headers: string[];
  /** One example line, replaced by your own. */
  rows: string[][];
};

export type InfoSheet = {
  key: string;
  label: string;
  about: string;
  /** Answered once per site on the Questions tab. */
  questions: string[];
  /** Short lists, only where names matter. */
  tabs: InfoSheetTab[];
};

/** The business's sites, so the Questions tab has an answer column for each. */
export type InfoSheetContext = { modules?: string[]; sites?: string[] };

export const QUESTIONS_TAB = "Questions";

const SHEETS: InfoSheet[] = [
  {
    key: "getting-started",
    label: "Getting started (every business)",
    about: "Your sites and the people who will use ComplyTrack. Fill this in first.",
    questions: [
      "Roughly how many staff work here?",
      "Which departments or teams do you have? (e.g. Kitchen, Housekeeping, Greenkeeping)",
      "Who will look after ComplyTrack day to day?",
    ],
    tabs: [
      {
        name: "Sites", about: "One line per premises.",
        headers: ["Site name", "Address"],
        rows: [["Main building", "1 High Street, Anytown AB1 2CD"]],
      },
      {
        name: "Logins", about: "Everyone who will sign in. Owners see billing; Managers look after departments; Staff record checks.",
        headers: ["Name", "Email", "Role (Owner, Manager or Staff)"],
        rows: [["Alex Brown", "alex.brown@example.com", "Manager"]],
      },
      {
        name: "Staff roster", about: "All other staff, for training records and sign-offs. They don't need a login.",
        importsInto: "Staff Roster > Import spreadsheet",
        headers: ["Name", "Job Title", "Department"],
        rows: [["Jane Smith", "Chef", "Kitchen"]],
      },
    ],
  },
  {
    key: "contractors",
    label: "Contractors",
    about: "Everyone who services, inspects or repairs for you, and what they do.",
    questions: [],
    tabs: [
      {
        name: "Contractors", about: "One line per contractor: who they are and what they do for you (e.g. fire alarm, gas, electrics, pest control).",
        importsInto: "Contractors > Import spreadsheet",
        headers: ["Company", "What they do", "Contact name", "Phone", "Email"],
        rows: [["Patel Electrical Ltd", "Electrical testing (EICR), PAT testing", "Sam Patel", "01234 567890", "sam@example.co.uk"]],
      },
    ],
  },
  {
    key: "compliance",
    label: "Compliance Checks",
    about: "The building's servicing, inspections and certificates.",
    questions: [
      "Do you have a gas supply? (Yes/No)",
      "How many boilers?",
      "How many passenger or goods lifts?",
      "Do you have air conditioning? (Yes/No)",
      "Do you have pressure equipment, e.g. a coffee machine or compressor? (Yes/No)",
      "Was the building built before 2000? (Yes/No, for asbestos)",
      "Do you have an asbestos survey? (Yes/No)",
    ],
    tabs: [],
  },
  {
    key: "firetrack",
    label: "FireTrack",
    about: "Fire alarm, call points and fire equipment.",
    questions: [
      "How many fire alarm call points?",
      "How many fire extinguishers?",
      "How many emergency light fittings?",
      "How many fire doors?",
      "Do people sleep on site? (Yes/No)",
      "Do you have sprinklers? (Yes/No)",
      "Do you have a kitchen fire suppression system? (Yes/No)",
    ],
    tabs: [
      {
        name: "Call points", about: "Optional: your call points by name, in the order you test them. Otherwise they're numbered CP1, CP2 and so on.",
        importsInto: "FireTrack > Call points > Import spreadsheet",
        headers: ["Call point", "Location", "Site"],
        rows: [["CP1", "Reception, main entrance", ""]],
      },
    ],
  },
  {
    key: "kitchentrack",
    label: "KitchenTrack",
    about: "Fridges, freezers and food safety.",
    questions: [
      "How many kitchens?",
      "How many fridges?",
      "How many freezers?",
      "How many display fridges or chillers?",
      "How many hot holding units?",
      "How many temperature probes?",
      "Do you have a HACCP or food safety plan? (Yes/No)",
    ],
    tabs: [],
  },
  {
    key: "legionellatrack",
    label: "LegionellaTrack",
    about: "Water outlets you test and flush.",
    questions: [
      "Do you have a legionella risk assessment? (Yes/No)",
      "How many showers?",
      "How many hot water cylinders or calorifiers?",
      "How many cold water tanks?",
      "How many thermostatic mixing valves (TMVs)?",
    ],
    tabs: [
      {
        name: "Sentinel taps", about: "Which taps are your sentinel outlets: usually the nearest and furthest from each tank or heater. Your legionella risk assessment lists them.",
        headers: ["Tap", "Where", "Hot or cold", "Site"],
        rows: [["Kitchen sink", "Main kitchen", "Hot", "Main building"]],
      },
    ],
  },
  {
    key: "pattrack",
    label: "PATtrack",
    about: "Portable electrical appliances.",
    questions: [
      "Roughly how many portable appliances?",
      "When was your last PAT test? (month and year)",
    ],
    tabs: [
      {
        name: "Appliances", about: "Optional: if you already have an appliance list.",
        importsInto: "PATtrack > Import spreadsheet",
        headers: ["Appliance name", "Site", "Location"],
        rows: [["Kettle", "Main building", "Staff kitchen"]],
      },
    ],
  },
  {
    key: "roomtrack",
    label: "RoomTrack",
    about: "The rooms you check.",
    questions: ["How many rooms do you check?"],
    tabs: [
      {
        name: "Rooms", about: "Optional: your rooms by number.",
        importsInto: "RoomTrack > Import spreadsheet",
        headers: ["Room number", "Floor", "Site"],
        rows: [["101", "Ground", "Main building"]],
      },
    ],
  },
  {
    key: "greentrack",
    label: "GreenTrack",
    about: "Grounds machinery and spraying.",
    questions: [
      "How many greens mowers (ride-on)?",
      "How many greens mowers (hand)?",
      "How many other ride-on mowers?",
      "How many pedestrian machines (strimmers, blowers and so on)?",
      "How many tractors or utility vehicles?",
      "How many sprayers?",
      "How many people hold spraying certificates (PA1, PA2, PA6)?",
    ],
    tabs: [
      {
        name: "Equipment", about: "Optional: if you already have a machine list.",
        importsInto: "GreenTrack > Equipment > Import spreadsheet",
        headers: ["name", "type", "make", "model", "site"],
        rows: [["Greens mower 1", "greens mower - ride on", "Toro", "Greensmaster 3150", ""]],
      },
    ],
  },
  {
    key: "coshhtrack",
    label: "COSHHTrack",
    about: "Hazardous substances.",
    questions: [
      "Roughly how many hazardous products do you use (cleaning chemicals, fuels, pesticides)?",
      "Do you have safety data sheets for them? (Yes/No/Some)",
      "Do you have extraction (LEV) that needs testing? (Yes/No)",
    ],
    tabs: [],
  },
  {
    key: "traintrack",
    label: "TrainTrack",
    about: "Staff training.",
    questions: [
      "Which training do your staff need? (e.g. food hygiene, first aid, fire marshal)",
      "Do you have copies of staff certificates? (Yes/No/Some)",
    ],
    tabs: [],
  },
  {
    key: "doctrack",
    label: "DocTrack",
    about: "Policies and risk assessments.",
    questions: [
      "Do you have a health and safety policy? (Yes/No)",
      "Do you have a fire risk assessment? (Yes/No)",
      "Do you have written risk assessments? (Yes/No)",
      "Do you have a staff handbook? (Yes/No)",
    ],
    tabs: [],
  },
  {
    key: "fixtrack",
    label: "FixTrack",
    about: "Repairs and maintenance.",
    questions: [
      "How many repairs are waiting to be done right now?",
      "Who do you usually call for repairs?",
    ],
    tabs: [],
  },
  {
    key: "incidenttrack",
    label: "IncidentTrack",
    about: "Accidents and first aid.",
    questions: [
      "How many first aid kits?",
      "How many first aiders?",
      "Do you keep an accident book? (Yes/No)",
    ],
    tabs: [],
  },
  {
    key: "pesttrack",
    label: "PestTrack",
    about: "Pest control.",
    questions: [
      "Do you have a pest control contract? (Yes/No)",
      "How many visits a year?",
      "How many bait points and fly killers?",
    ],
    tabs: [],
  },
  {
    key: "premisestrack",
    label: "PremisesTrack",
    about: "Premises inspections.",
    questions: ["Which areas do you inspect? (e.g. car park, paths, roof, play area)"],
    tabs: [],
  },
  {
    key: "hottubtrack",
    label: "TubTrack",
    about: "Hot tubs.",
    questions: ["How many hot tubs?", "Chlorine or bromine?"],
    tabs: [],
  },
  {
    key: "aquatrack",
    label: "AquaTrack",
    about: "Pools and spas.",
    questions: ["How many swimming pools?", "How many spa pools?"],
    tabs: [],
  },
  {
    key: "treetrack",
    label: "TreeTrack",
    about: "Tree inspections.",
    questions: [
      "Roughly how many trees or tree areas need inspecting?",
      "Have you had a tree survey? (Yes/No, and when)",
    ],
    tabs: [],
  },
  {
    key: "biketrack",
    label: "BikeTrack",
    about: "Hire bikes.",
    questions: ["How many hire bikes?", "Who services them?"],
    tabs: [],
  },
  {
    key: "dailytrack",
    label: "DailyTrack (opening and closing checks)",
    about: "Opening and closing checks.",
    questions: ["Which teams do opening checks?", "Which teams do closing checks?"],
    tabs: [],
  },
];

export const INFO_SHEETS: InfoSheet[] = SHEETS;

/** The Questions tab: one answer column per site (a single "Answer" column when no sites are known). */
export function questionsTab(sheet: InfoSheet, context: InfoSheetContext = {}): InfoSheetTab {
  const sites = context.sites?.length ? context.sites : ["Answer"];
  return {
    name: QUESTIONS_TAB,
    about: "A number, Yes/No or a few words. Leave blank anything you're not sure of.",
    headers: ["Question", ...sites, "Notes"],
    rows: sheet.questions.map((question) => [question, ...sites.map(() => ""), ""]),
  };
}

/** The workbook's tabs as downloaded: Questions first (when it has any), then its lists. */
export function infoSheetTabs(sheet: InfoSheet, context: InfoSheetContext = {}): InfoSheetTab[] {
  return [...(sheet.questions.length ? [questionsTab(sheet, context)] : []), ...sheet.tabs];
}

/** The Read me tab: three steps, and the offer to have ALPS do it. */
export function readMeRows(sheet: InfoSheet, context: InfoSheetContext = {}): string[][] {
  return [
    [`ComplyTrack: ${sheet.label}. What we need from you`],
    [sheet.about],
    [],
    ["1. Answer the questions: a number, Yes/No or a few words. Leave blank anything you're not sure of."],
    ["2. If you already have a list, fill in or paste it on the other tabs. Don't worry about detail: you add that in ComplyTrack once you're in."],
    ["3. Upload this workbook at Set up > Upload your lists, or send it to your ALPS consultant."],
    [],
    [`Rather not? ALPS can set it all up for you for a one-off ${SETUP_SERVICE_FEE}. Ask from Set up > Upload your lists.`],
    [],
    ["Tab", "What it's for"],
    ...infoSheetTabs(sheet, context).map((tab) => [tab.name, tab.about]),
  ];
}

export async function downloadInfoSheet(sheet: InfoSheet, context: InfoSheetContext = {}) {
  const { downloadWorkbook } = await import("@/lib/spreadsheet");
  downloadWorkbook(`complytrack-${sheet.key}-information.xlsx`, [
    { name: "Read me", rows: readMeRows(sheet, context) },
    ...infoSheetTabs(sheet, context).map((tab) => ({ name: tab.name, rows: [tab.headers, ...tab.rows] })),
  ]);
}
