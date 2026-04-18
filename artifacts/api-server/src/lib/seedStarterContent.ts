import { db } from "@workspace/db";
import { categoriesTable, complianceItemsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const daysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

interface StarterCategory {
  name: string;
  color: string;
  checks: Array<{
    title: string;
    description: string;
    priority: "low" | "medium" | "high" | "critical";
    dueInDays: number;
    leadTimeDays?: number;
  }>;
}

const STARTER: StarterCategory[] = [
  {
    name: "Gas",
    color: "#f97316",
    checks: [
      { title: "Gas Boilers — Annual Service", description: "Annual service and gas safety check on all gas boilers by a Gas Safe registered engineer.", priority: "high", dueInDays: 120, leadTimeDays: 21 },
      { title: "Gas Fireplaces — Annual Service", description: "Annual service and gas safety check on all gas fireplaces by a Gas Safe registered engineer.", priority: "high", dueInDays: 120, leadTimeDays: 21 },
      { title: "Gas Kitchen Equipment — Annual Service", description: "Annual service and gas safety check on commercial kitchen gas appliances by a Gas Safe registered engineer.", priority: "high", dueInDays: 120, leadTimeDays: 21 },
      { title: "Oil Boilers — Annual Service", description: "Annual service and safety check on oil-fired boilers by an OFTEC registered engineer.", priority: "high", dueInDays: 120, leadTimeDays: 21 },
    ],
  },
  {
    name: "Fire",
    color: "#ef4444",
    checks: [
      { title: "Fire Alarm Maintenance", description: "Six-monthly servicing of the fire alarm system by a competent contractor (BS 5839).", priority: "high", dueInDays: 90, leadTimeDays: 21 },
      { title: "Emergency Light Maintenance", description: "Annual three-hour duration test and certification of emergency lighting (BS 5266).", priority: "high", dueInDays: 90, leadTimeDays: 14 },
      { title: "AOV — Automatic Opening Vents Service", description: "Annual service and test of automatic opening vent / smoke ventilation systems.", priority: "high", dueInDays: 120, leadTimeDays: 21 },
      { title: "Fire Extinguishers Maintenance", description: "Annual service of all portable fire extinguishers (BS 5306-3).", priority: "high", dueInDays: 120, leadTimeDays: 21 },
      { title: "Private Fire Hydrant Inspection", description: "Annual inspection and flow test of any privately owned fire hydrants on site.", priority: "high", dueInDays: 180, leadTimeDays: 30 },
      { title: "Fire Marshal Training", description: "Training / refresher for designated fire marshals.", priority: "medium", dueInDays: 365, leadTimeDays: 30 },
      { title: "Kitchen Extraction Deep Clean", description: "Deep clean of kitchen extraction ductwork and canopy to TR19 standard.", priority: "high", dueInDays: 180, leadTimeDays: 21 },
      { title: "Chimney Sweep", description: "Sweep and inspection of chimneys and flues.", priority: "medium", dueInDays: 365, leadTimeDays: 21 },
    ],
  },
  {
    name: "Electrical",
    color: "#f59e0b",
    checks: [
      { title: "Electrical Appliance Testing (PAT)", description: "Portable appliance testing of in-scope electrical equipment.", priority: "medium", dueInDays: 365, leadTimeDays: 21 },
      { title: "Electrical Installation Condition Report (EICR)", description: "Five-yearly fixed wiring inspection and EICR (BS 7671).", priority: "high", dueInDays: 365, leadTimeDays: 30 },
      { title: "EV Charger Inspection", description: "Annual inspection and test of electric vehicle charging equipment.", priority: "medium", dueInDays: 365, leadTimeDays: 21 },
    ],
  },
  {
    name: "LOLER",
    color: "#8b5cf6",
    checks: [
      { title: "Passenger Lift — Thorough Examination", description: "Six-monthly thorough examination of passenger lifts under LOLER 1998.", priority: "critical", dueInDays: 180, leadTimeDays: 30 },
      { title: "Goods Lift — Thorough Examination", description: "Twelve-monthly thorough examination of goods lifts under LOLER 1998.", priority: "high", dueInDays: 365, leadTimeDays: 30 },
      { title: "Vehicle Lift — Thorough Examination", description: "Six-monthly thorough examination of vehicle lifts under LOLER 1998.", priority: "high", dueInDays: 180, leadTimeDays: 30 },
      { title: "Fork Lift Truck — Thorough Examination", description: "Twelve-monthly thorough examination of fork lift trucks under LOLER 1998.", priority: "high", dueInDays: 365, leadTimeDays: 30 },
      { title: "Vehicle Stands — Thorough Examination", description: "Twelve-monthly thorough examination of axle / vehicle support stands under LOLER 1998.", priority: "high", dueInDays: 365, leadTimeDays: 30 },
    ],
  },
  {
    name: "Legionella",
    color: "#06b6d4",
    checks: [
      { title: "Legionella Risk Assessment", description: "Two-yearly review of the legionella risk assessment for the water system (HSG274 / ACOP L8).", priority: "high", dueInDays: 365, leadTimeDays: 30 },
      { title: "Clean & Disinfect Water Tanks", description: "Annual clean, disinfection and inspection of cold water storage tanks.", priority: "high", dueInDays: 365, leadTimeDays: 30 },
    ],
  },
  {
    name: "Pressure Systems",
    color: "#0ea5e9",
    checks: [
      { title: "Compressor — Written Scheme Examination", description: "Periodic examination of air compressors under the Pressure Systems Safety Regulations 2000.", priority: "high", dueInDays: 365, leadTimeDays: 30 },
      { title: "Coffee Machine — Written Scheme Examination", description: "Periodic examination of espresso / coffee machine pressure vessels under PSSR 2000.", priority: "medium", dueInDays: 365, leadTimeDays: 30 },
    ],
  },
  {
    name: "HVAC",
    color: "#10b981",
    checks: [
      { title: "TM44 Air Conditioning Inspection", description: "Five-yearly TM44 inspection of air conditioning systems over 12 kW.", priority: "medium", dueInDays: 365, leadTimeDays: 30 },
    ],
  },
];

/**
 * Seed a brand-new client with example categories and compliance checks so the
 * app isn't empty on first login. Everything is editable / deletable like
 * normal user-created data.
 */
export async function seedStarterContent(clientId: number) {
  try {
    for (const cat of STARTER) {
      const [inserted] = await db.insert(categoriesTable).values({
        clientId,
        name: cat.name,
        color: cat.color,
      }).returning();

      if (cat.checks.length === 0) continue;

      await db.insert(complianceItemsTable).values(
        cat.checks.map(c => ({
          clientId,
          categoryId: inserted.id,
          title: c.title,
          description: c.description,
          status: "pending" as const,
          priority: c.priority,
          dueDate: daysFromNow(c.dueInDays),
          leadTimeDays: c.leadTimeDays,
        }))
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
 */
export async function seedSiteStarterChecks(clientId: number, siteId: number) {
  try {
    // Look up existing categories for this client so we can reuse them.
    const existing = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.clientId, clientId));
    const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));

    for (const cat of STARTER) {
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

      if (cat.checks.length === 0) continue;

      await db.insert(complianceItemsTable).values(
        cat.checks.map((c) => ({
          clientId,
          siteId,
          categoryId,
          title: c.title,
          description: c.description,
          status: "pending" as const,
          priority: c.priority,
          dueDate: daysFromNow(c.dueInDays),
          leadTimeDays: c.leadTimeDays,
        })),
      );
    }
  } catch (err) {
    logger.error({ err, clientId, siteId }, "Failed to seed starter checks for new site");
  }
}
