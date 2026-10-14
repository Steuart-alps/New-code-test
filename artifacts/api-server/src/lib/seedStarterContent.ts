import { db } from "@workspace/db";
import { categoriesTable, clientsTable, complianceItemsTable } from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";

interface StarterCheck {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  leadTimeDays?: number;
  /** Repeat interval once completed; omitted where it depends on the premises
   *  or a competent person (the business sets it). */
  frequencyMonths?: number;
  /** Interval for particular business types, overriding frequencyMonths. */
  frequencyMonthsByBusinessType?: Record<string, number>;
  /** Only seeded for these business types (the type chosen at signup). */
  businessTypes?: string[];
}

interface StarterCategory {
  name: string;
  color: string;
  checks: StarterCheck[];
}

/** Seeded checks carry no invented due date: the business sets it from the
 *  last service or inspection. This note says so on every starter check. */
export const STARTER_CHECK_NOTE =
  "Starter check: set the due date from your last service or inspection date, adjust the repeat interval to your premises, or delete this check if it does not apply.";

export const STARTER: StarterCategory[] = [
  {
    name: "Gas",
    color: "#f97316",
    checks: [
      { title: "Gas Boilers — Annual Service", description: "Annual service and gas safety check on all gas boilers by a Gas Safe registered engineer.", priority: "high", leadTimeDays: 21, frequencyMonths: 12 },
      { title: "Gas Fireplaces — Annual Service", description: "Annual service and gas safety check on all gas fireplaces by a Gas Safe registered engineer.", priority: "high", leadTimeDays: 21, frequencyMonths: 12 },
      { title: "Gas Kitchen Equipment — Annual Service", description: "Annual service and gas safety check on commercial kitchen gas appliances by a Gas Safe registered engineer.", priority: "high", leadTimeDays: 21, frequencyMonths: 12 },
      { title: "Oil Boilers — Annual Service", description: "Annual service and safety check on oil-fired boilers by an OFTEC registered engineer.", priority: "high", leadTimeDays: 21, frequencyMonths: 12 },
      { title: "Let Caravans & Lodges — Annual Gas Safety Check", description: "Gas safety check of every let caravan, lodge or holiday home with gas appliances at least every 12 months by a Gas Safe registered engineer, with the record kept and given to occupiers (Gas Safety (Installation and Use) Regulations 1998, reg 36).", priority: "critical", leadTimeDays: 30, frequencyMonths: 12, businessTypes: ["holiday_park_campsite"] },
    ],
  },
  {
    name: "Fire",
    color: "#ef4444",
    checks: [
      { title: "Fire Risk Assessment Review", description: "Review the fire risk assessment regularly and whenever there is a significant change to the premises, work or people at risk (Regulatory Reform (Fire Safety) Order 2005 in England and Wales; Fire (Scotland) Act 2005 in Scotland). Annual review is common practice; agree the interval with your fire risk assessor.", priority: "critical", leadTimeDays: 30, frequencyMonths: 12 },
      { title: "Fire Alarm Maintenance", description: "Six-monthly servicing of the fire alarm system by a competent contractor (BS 5839).", priority: "high", leadTimeDays: 21, frequencyMonths: 6 },
      { title: "Emergency Light Maintenance", description: "Annual three-hour duration test and certification of emergency lighting (BS 5266).", priority: "high", leadTimeDays: 14, frequencyMonths: 12 },
      { title: "AOV — Automatic Opening Vents Service", description: "Annual service and test of automatic opening vent / smoke ventilation systems.", priority: "high", leadTimeDays: 21, frequencyMonths: 12 },
      { title: "Fire Extinguishers Maintenance", description: "Annual service of all portable fire extinguishers (BS 5306-3).", priority: "high", leadTimeDays: 21, frequencyMonths: 12 },
      { title: "Private Fire Hydrant Inspection", description: "Annual inspection and flow test of any privately owned fire hydrants on site.", priority: "high", leadTimeDays: 30, frequencyMonths: 12 },
      { title: "Fire Marshal Training", description: "Training / refresher for designated fire marshals.", priority: "medium", leadTimeDays: 30 },
      { title: "Kitchen Extraction Deep Clean", description: "Deep clean of kitchen extraction ductwork and canopy to TR19 standard, at an interval set by how heavily the kitchen is used.", priority: "high", leadTimeDays: 21 },
      { title: "Chimney Sweep", description: "Sweep and inspection of chimneys and flues.", priority: "medium", leadTimeDays: 21, frequencyMonths: 12 },
    ],
  },
  {
    name: "Electrical",
    color: "#f59e0b",
    checks: [
      { title: "Electrical Appliance Testing (PAT)", description: "Portable appliance testing of in-scope electrical equipment, at intervals based on the type of equipment and how it is used.", priority: "medium", leadTimeDays: 21 },
      {
        title: "Electrical Installation Condition Report (EICR)",
        description: "Periodic inspection of the fixed wiring with an Electrical Installation Condition Report (BS 7671). Set the interval from IET Guidance Note 3 for your premises type and the last report's recommendation — for example 5 years for hotels, offices and care homes, and 1 year for caravan parks and swimming pools.",
        priority: "high",
        leadTimeDays: 30,
        frequencyMonthsByBusinessType: {
          hotel_accommodation: 60,
          care_home_healthcare: 60,
          offices_commercial: 60,
          retail: 60,
          restaurant_cafe_pub: 60,
          nursery_school: 60,
          holiday_park_campsite: 12,
          leisure_sports_centre: 12,
        },
      },
      { title: "EV Charger Inspection", description: "Annual inspection and test of electric vehicle charging equipment.", priority: "medium", leadTimeDays: 21, frequencyMonths: 12 },
    ],
  },
  {
    name: "LOLER",
    color: "#8b5cf6",
    checks: [
      { title: "Passenger Lift — Thorough Examination", description: "Six-monthly thorough examination of passenger lifts under LOLER 1998.", priority: "critical", leadTimeDays: 30, frequencyMonths: 6 },
      { title: "Patient Hoists & Slings — Thorough Examination", description: "Thorough examination of patient hoists and slings at least every six months by a competent person, as equipment for lifting people and lifting accessories (LOLER 1998, reg 9).", priority: "critical", leadTimeDays: 30, frequencyMonths: 6, businessTypes: ["care_home_healthcare"] },
      { title: "Goods Lift — Thorough Examination", description: "Twelve-monthly thorough examination of goods lifts under LOLER 1998.", priority: "high", leadTimeDays: 30, frequencyMonths: 12 },
      { title: "Vehicle Lift — Thorough Examination", description: "Six-monthly thorough examination of vehicle lifts under LOLER 1998.", priority: "high", leadTimeDays: 30, frequencyMonths: 6 },
      { title: "Fork Lift Truck — Thorough Examination", description: "Twelve-monthly thorough examination of fork lift trucks under LOLER 1998.", priority: "high", leadTimeDays: 30, frequencyMonths: 12 },
      { title: "Vehicle Stands — Thorough Examination", description: "Twelve-monthly thorough examination of axle / vehicle support stands under LOLER 1998.", priority: "high", leadTimeDays: 30, frequencyMonths: 12 },
    ],
  },
  {
    name: "Legionella",
    color: "#06b6d4",
    checks: [
      { title: "Legionella Risk Assessment", description: "Review the legionella risk assessment regularly and whenever there is reason to think it is no longer valid, such as a significant change to the water system or its use. Your competent person sets the review interval (ACOP L8, 4th edition; HSG274).", priority: "high", leadTimeDays: 30 },
      { title: "Clean & Disinfect Water Tanks", description: "Annual inspection of cold water storage tanks, with cleaning and disinfection when the inspection shows it is needed (HSG274).", priority: "high", leadTimeDays: 30, frequencyMonths: 12 },
    ],
  },
  {
    name: "Asbestos",
    color: "#78716c",
    checks: [
      { title: "Asbestos Management Survey & Register Review", description: "For buildings built before 2000: hold an asbestos management survey and register, and regularly review the asbestos management plan and the condition of known materials (Control of Asbestos Regulations 2012, reg 4). Delete this check if the building was built in 2000 or later.", priority: "high", leadTimeDays: 30, frequencyMonths: 12 },
    ],
  },
  {
    name: "Pressure Systems",
    color: "#0ea5e9",
    checks: [
      { title: "Compressor — Written Scheme Examination", description: "Examination of air compressors at the interval in the written scheme of examination (Pressure Systems Safety Regulations 2000).", priority: "high", leadTimeDays: 30 },
      { title: "Coffee Machine — Written Scheme Examination", description: "Examination of espresso / coffee machine pressure vessels at the interval in the written scheme of examination (PSSR 2000).", priority: "medium", leadTimeDays: 30 },
    ],
  },
  {
    name: "HVAC",
    color: "#10b981",
    checks: [
      { title: "TM44 Air Conditioning Inspection", description: "Five-yearly TM44 inspection of air conditioning systems over 12 kW.", priority: "medium", leadTimeDays: 30, frequencyMonths: 60 },
    ],
  },
  {
    name: "Insurance",
    color: "#64748b",
    checks: [
      { title: "Employers' Liability Insurance Certificate", description: "Renew employers' liability insurance before it expires and display the current certificate where employees can easily read it, or make it available to them electronically (Employers' Liability (Compulsory Insurance) Act 1969).", priority: "critical", leadTimeDays: 30, frequencyMonths: 12 },
    ],
  },
  {
    name: "Premises",
    color: "#a855f7",
    checks: [
      { title: "Playground Equipment — Annual Inspection", description: "Annual main inspection of play equipment by a competent inspector, with routine and operational checks in between (BS EN 1176-7).", priority: "high", leadTimeDays: 30, frequencyMonths: 12, businessTypes: ["holiday_park_campsite"] },
    ],
  },
];

/** The starter categories and checks that apply to a business type. */
export function starterChecksFor(businessType: string | null | undefined): StarterCategory[] {
  return STARTER
    .map((cat) => ({
      ...cat,
      checks: cat.checks.filter((c) => !c.businessTypes || (businessType != null && c.businessTypes.includes(businessType))),
    }))
    .filter((cat) => cat.checks.length > 0);
}

function starterFrequency(check: StarterCheck, businessType: string | null | undefined): number | null {
  if (businessType && check.frequencyMonthsByBusinessType?.[businessType] != null) {
    return check.frequencyMonthsByBusinessType[businessType];
  }
  return check.frequencyMonths ?? null;
}

export function starterItemValues(check: StarterCheck, businessType: string | null | undefined) {
  return {
    title: check.title,
    description: check.description,
    status: "pending" as const,
    priority: check.priority,
    dueDate: null,
    leadTimeDays: check.leadTimeDays,
    frequencyMonths: starterFrequency(check, businessType),
    notes: STARTER_CHECK_NOTE,
  };
}

async function businessTypeOf(clientId: number): Promise<string | null> {
  const [row] = await db
    .select({ businessType: clientsTable.businessType })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId));
  return row?.businessType ?? null;
}

/**
 * Seed a brand-new client with example categories and compliance checks so the
 * app isn't empty on first login. Everything is editable / deletable like
 * normal user-created data.
 */
export async function seedStarterContent(clientId: number) {
  try {
    const businessType = await businessTypeOf(clientId);
    for (const cat of starterChecksFor(businessType)) {
      const [inserted] = await db.insert(categoriesTable).values({
        clientId,
        name: cat.name,
        color: cat.color,
      }).returning();

      await db.insert(complianceItemsTable).values(
        cat.checks.map(c => ({ clientId, categoryId: inserted.id, ...starterItemValues(c, businessType) })),
      );
    }
  } catch (err) {
    logger.error({ err, clientId }, "Failed to seed starter content for new client");
  }
}

/**
 * Seed a brand-new SITE with the starter pack of compliance checks. Reuses
 * existing categories on the client (matching by name) and creates any that
 * are missing. All checks are tagged with the given siteId so they're tracked
 * independently per site.
 *
 * Starter checks the business already holds unassigned and untouched (seeded
 * at signup, never edited) are moved onto the site instead of copied, so the
 * business does not end up with a site copy of each item it already has.
 */
export async function seedSiteStarterChecks(clientId: number, siteId: number) {
  try {
    // Guard: if this site already has compliance items, skip seeding so the
    // starter pack cannot be loaded more than once per site.
    const alreadySeeded = await db
      .select({ id: complianceItemsTable.id })
      .from(complianceItemsTable)
      .where(eq(complianceItemsTable.siteId, siteId))
      .limit(1);
    if (alreadySeeded.length > 0) {
      logger.info({ clientId, siteId }, "Skipping site starter seed — items already exist for this site");
      return;
    }

    const businessType = await businessTypeOf(clientId);
    const categories = starterChecksFor(businessType);

    // Unassigned starter checks still exactly as seeded (never updated).
    const titles = categories.flatMap((cat) => cat.checks.map((c) => c.title));
    const untouched = titles.length === 0 ? [] : await db
      .select({ id: complianceItemsTable.id, title: complianceItemsTable.title })
      .from(complianceItemsTable)
      .where(and(
        eq(complianceItemsTable.clientId, clientId),
        isNull(complianceItemsTable.siteId),
        inArray(complianceItemsTable.title, titles),
        eq(complianceItemsTable.notes, STARTER_CHECK_NOTE),
        sql`${complianceItemsTable.updatedAt} = ${complianceItemsTable.createdAt}`,
      ));
    const unassignedByTitle = new Map(untouched.map((row) => [row.title, row.id]));

    // Look up existing categories for this client so we can reuse them.
    const existing = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.clientId, clientId));
    const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));

    for (const cat of categories) {
      const toClaim = cat.checks.filter((c) => unassignedByTitle.has(c.title)).map((c) => unassignedByTitle.get(c.title)!);
      if (toClaim.length > 0) {
        await db
          .update(complianceItemsTable)
          .set({ siteId })
          .where(and(
            eq(complianceItemsTable.clientId, clientId),
            isNull(complianceItemsTable.siteId),
            inArray(complianceItemsTable.id, toClaim),
          ));
      }

      const toCreate = cat.checks.filter((c) => !unassignedByTitle.has(c.title));
      if (toCreate.length === 0) continue;

      let categoryId: number;
      const found = byName.get(cat.name.toLowerCase());
      if (found) {
        categoryId = found.id;
      } else {
        const [inserted] = await db
          .insert(categoriesTable)
          .values({ clientId, name: cat.name, color: cat.color })
          .returning();
        categoryId = inserted.id;
      }

      await db.insert(complianceItemsTable).values(
        toCreate.map((c) => ({ clientId, siteId, categoryId, ...starterItemValues(c, businessType) })),
      );
    }
  } catch (err) {
    logger.error({ err, clientId, siteId }, "Failed to seed starter checks for new site");
  }
}
