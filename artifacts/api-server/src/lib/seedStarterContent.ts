import { db } from "@workspace/db";
import { categoriesTable, complianceItemsTable } from "@workspace/db/schema";
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
    name: "Fire Safety",
    color: "#ef4444",
    checks: [
      { title: "Fire Risk Assessment Review", description: "Annual review by a competent person.", priority: "high", dueInDays: 60, leadTimeDays: 21 },
      { title: "Fire Alarm System Test", description: "Quarterly fire alarm and smoke detector test.", priority: "high", dueInDays: 30, leadTimeDays: 14 },
      { title: "Emergency Lighting Annual Test", description: "Three-hour duration test on all emergency lights.", priority: "high", dueInDays: 90, leadTimeDays: 14 },
      { title: "Fire Extinguisher Annual Service", description: "Service of all fire extinguishers on site.", priority: "high", dueInDays: 120, leadTimeDays: 21 },
    ],
  },
  {
    name: "Electrical",
    color: "#f59e0b",
    checks: [
      { title: "PAT Testing — Office Equipment", description: "Annual portable appliance testing.", priority: "medium", dueInDays: 90, leadTimeDays: 21 },
      { title: "EICR Fixed Wiring Inspection", description: "Five-yearly fixed wiring inspection.", priority: "high", dueInDays: 365, leadTimeDays: 30 },
    ],
  },
  {
    name: "Staff Training",
    color: "#10b981",
    checks: [
      { title: "First Aid at Work Refresher", description: "Recertification for designated first aiders.", priority: "medium", dueInDays: 90 },
      { title: "Manual Handling Training", description: "Refresher training for all relevant staff.", priority: "medium", dueInDays: 180 },
      { title: "Fire Marshal Training", description: "Training/refresher for designated fire marshals.", priority: "medium", dueInDays: 120 },
    ],
  },
  {
    name: "Premises",
    color: "#3b82f6",
    checks: [
      { title: "Legionella Risk Assessment", description: "Periodic review of water systems risk assessment.", priority: "medium", dueInDays: 180, leadTimeDays: 30 },
      { title: "Asbestos Management Review", description: "Annual reinspection of identified asbestos materials (if applicable).", priority: "medium", dueInDays: 180, leadTimeDays: 30 },
      { title: "Gas Safety Inspection", description: "Annual inspection of gas appliances by a Gas Safe engineer.", priority: "high", dueInDays: 120, leadTimeDays: 21 },
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
