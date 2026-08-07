import { db } from "@workspace/db";
import {
  clientsTable,
  usersTable,
  departmentsTable,
  categoriesTable,
  contractorsTable,
  certificatesTable,
  complianceItemsTable,
} from "@workspace/db/schema";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

const DEMO = {
  clientSlug: "acme-demo",
  clientName: "Acme Manufacturing Ltd",
  adminEmail: "demo@complytrack.com",
  adminPassword: "Demo1234!",
  staffEmail: "staff.demo@complytrack.com",
  staffPassword: "Demo1234!",
  viewerEmail: "viewer.demo@complytrack.com",
  viewerPassword: "Demo1234!",
};

const daysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

export async function seedDemo() {
  // Wipe any prior demo client to keep things idempotent
  const existing = await db.select().from(clientsTable).where(eq(clientsTable.slug, DEMO.clientSlug)).limit(1);
  if (existing.length > 0) {
    await db.delete(clientsTable).where(eq(clientsTable.id, existing[0].id));
  }

  const [client] = await db.insert(clientsTable).values({
    name: DEMO.clientName,
    slug: DEMO.clientSlug,
    primaryColor: "#0ea5e9",
    subscriptionStatus: "active",
    trialEndsAt: daysFromNow(365),
  }).returning();

  const [hq, warehouse, factory] = await db.insert(departmentsTable).values([
    { clientId: client.id, name: "Head Office", description: "London HQ — administrative site" },
    { clientId: client.id, name: "Manchester Warehouse", description: "Distribution & storage" },
    { clientId: client.id, name: "Birmingham Factory", description: "Production line & machinery" },
  ]).returning();

  const [fireSafety, electrical, asbestos, fireExt, training, hvac] = await db.insert(categoriesTable).values([
    { clientId: client.id, name: "Fire Safety", color: "#ef4444" },
    { clientId: client.id, name: "Electrical (PAT/EICR)", color: "#f59e0b" },
    { clientId: client.id, name: "Asbestos Management", color: "#8b5cf6" },
    { clientId: client.id, name: "Fire Extinguishers", color: "#dc2626" },
    { clientId: client.id, name: "Staff Training", color: "#10b981" },
    { clientId: client.id, name: "HVAC & Air Quality", color: "#3b82f6" },
  ]).returning();

  const [adminHash, staffHash, viewerHash] = await Promise.all([
    bcrypt.hash(DEMO.adminPassword, 10),
    bcrypt.hash(DEMO.staffPassword, 10),
    bcrypt.hash(DEMO.viewerPassword, 10),
  ]);
  await db.insert(usersTable).values([
    { email: DEMO.adminEmail, passwordHash: adminHash, name: "Demo Admin", role: "client_admin", clientId: client.id, subscriptionStatus: "active" },
    { email: DEMO.staffEmail, passwordHash: staffHash, name: "Demo Staff", role: "client_staff", clientId: client.id, departmentId: warehouse.id, subscriptionStatus: "active" },
    { email: DEMO.viewerEmail, passwordHash: viewerHash, name: "Demo Viewer", role: "client_viewer", clientId: client.id, subscriptionStatus: "active" },
  ]);

  const [pyroguard, sparkright, asbestoscan, climatecare] = await db.insert(contractorsTable).values([
    { clientId: client.id, name: "Tom Bradley", company: "PyroGuard Fire Services Ltd", email: "tom@pyroguard.example.co.uk", phone: "020 7946 0123" },
    { clientId: client.id, name: "Priya Shah", company: "SparkRight Electrical", email: "priya@sparkright.example.co.uk", phone: "0161 496 0234" },
    { clientId: client.id, name: "David Ng", company: "AsbestoScan UK", email: "d.ng@asbestoscan.example.co.uk", phone: "0121 496 0345" },
    { clientId: client.id, name: "Rachel Owens", company: "ClimateCare HVAC", email: "rachel@climatecare.example.co.uk", phone: "020 7946 0456" },
  ]).returning();

  await db.insert(certificatesTable).values([
    { contractorId: pyroguard.id, name: "Public Liability Insurance", issueDate: daysFromNow(-180), expiryDate: daysFromNow(185), notes: "£10m cover" },
    { contractorId: pyroguard.id, name: "BAFE SP203-1 Certification", issueDate: daysFromNow(-90), expiryDate: daysFromNow(45), notes: "Expiring soon" },
    { contractorId: sparkright.id, name: "NICEIC Approved Contractor", issueDate: daysFromNow(-200), expiryDate: daysFromNow(165) },
    { contractorId: sparkright.id, name: "Public Liability Insurance", issueDate: daysFromNow(-365), expiryDate: daysFromNow(-15), notes: "EXPIRED — needs renewal" },
    { contractorId: asbestoscan.id, name: "UKAS Accreditation", issueDate: daysFromNow(-100), expiryDate: daysFromNow(265) },
    { contractorId: climatecare.id, name: "F-Gas Certification", issueDate: daysFromNow(-50), expiryDate: daysFromNow(315) },
    { contractorId: climatecare.id, name: "Refcom Elite Membership", issueDate: daysFromNow(-30), expiryDate: daysFromNow(335) },
  ]);

  // Sample compliance checks deliberately spread across due-date buckets so the
  // dashboard filters all light up: overdue, due ≤7d, due 8–30d, in date (>30d),
  // and completed.
  const items = [
    // --- OVERDUE (3) ---
    { clientId: client.id, departmentId: factory.id, categoryId: electrical.id, contractorId: sparkright.id, title: "Annual EICR Inspection — Factory Floor", description: "Five-yearly fixed wiring inspection due", status: "overdue", priority: "critical", dueDate: daysFromNow(-21), leadTimeDays: 30, assignedTo: "Operations Manager" },
    { clientId: client.id, departmentId: hq.id, categoryId: fireSafety.id, contractorId: pyroguard.id, title: "Fire Alarm System Test (Q4)", description: "Quarterly fire alarm and smoke detector test", status: "overdue", priority: "high", dueDate: daysFromNow(-9), leadTimeDays: 14 },
    { clientId: client.id, departmentId: warehouse.id, categoryId: fireExt.id, title: "Sprinkler Head Visual Inspection", description: "Six-monthly visual check missed last cycle", status: "pending", priority: "medium", dueDate: daysFromNow(-3) },

    // --- DUE IN ≤ 7 DAYS (3) ---
    { clientId: client.id, departmentId: warehouse.id, categoryId: fireExt.id, contractorId: pyroguard.id, title: "Fire Extinguisher Annual Service", description: "Service of all 24 extinguishers across warehouse", status: "in_progress", priority: "high", dueDate: daysFromNow(2), leadTimeDays: 21 },
    { clientId: client.id, departmentId: factory.id, categoryId: training.id, title: "Forklift Operator Refresher Training", description: "All forklift operators — 3 yearly refresher", status: "in_progress", priority: "medium", dueDate: daysFromNow(5), assignedTo: "HR Manager" },
    { clientId: client.id, departmentId: hq.id, categoryId: fireSafety.id, contractorId: pyroguard.id, title: "Weekly Fire Alarm Call-Point Test", description: "Routine weekly bell test", status: "pending", priority: "low", dueDate: daysFromNow(7) },

    // --- DUE IN 8–30 DAYS (3) ---
    { clientId: client.id, departmentId: factory.id, categoryId: electrical.id, title: "PAT Testing — Workshop Equipment", description: "Annual portable appliance testing", status: "pending", priority: "medium", dueDate: daysFromNow(14), leadTimeDays: 21 },
    { clientId: client.id, departmentId: factory.id, categoryId: fireSafety.id, contractorId: pyroguard.id, title: "Emergency Lighting Annual Test", description: "Three-hour duration test on all emergency lights", status: "pending", priority: "high", dueDate: daysFromNow(21), leadTimeDays: 14 },
    { clientId: client.id, departmentId: hq.id, categoryId: hvac.id, contractorId: climatecare.id, title: "Legionella Risk Assessment Review", description: "L8 ACOP — annual review of water systems", status: "pending", priority: "high", dueDate: daysFromNow(28), leadTimeDays: 21 },

    // --- IN DATE (> 30 DAYS OUT) (3) ---
    { clientId: client.id, departmentId: hq.id, categoryId: hvac.id, contractorId: climatecare.id, title: "Air Conditioning TM44 Inspection", description: "Energy efficiency assessment — every 5 years", status: "pending", priority: "medium", dueDate: daysFromNow(60), leadTimeDays: 30 },
    { clientId: client.id, departmentId: warehouse.id, categoryId: asbestos.id, contractorId: asbestoscan.id, title: "Asbestos Management Survey Update", description: "Annual reinspection of identified asbestos materials", status: "pending", priority: "high", dueDate: daysFromNow(75), leadTimeDays: 45 },
    { clientId: client.id, departmentId: hq.id, categoryId: training.id, title: "First Aid at Work Refresher", description: "Recertification for 4 designated first aiders", status: "pending", priority: "medium", dueDate: daysFromNow(120) },

    // --- COMPLETED (3, kept for context & completion-rate metric) ---
    { clientId: client.id, departmentId: hq.id, categoryId: fireSafety.id, title: "Fire Risk Assessment Review", description: "Annual review by competent person", status: "completed", priority: "high", dueDate: daysFromNow(-30), completedAt: daysFromNow(-32), notes: "No significant findings. Next review in 12 months." },
    { clientId: client.id, departmentId: warehouse.id, categoryId: training.id, title: "Manual Handling Training", description: "All warehouse staff completed RPLT-accredited course", status: "completed", priority: "medium", dueDate: daysFromNow(-60), completedAt: daysFromNow(-58) },
    { clientId: client.id, departmentId: hq.id, categoryId: electrical.id, contractorId: sparkright.id, title: "PAT Testing — Office Equipment", description: "All office appliances tested and tagged", status: "completed", priority: "low", dueDate: daysFromNow(-15), completedAt: daysFromNow(-15), notes: "2 items failed and were removed from service." },
  ];
  await db.insert(complianceItemsTable).values(items as any[]);

  return {
    business: client.name,
    sites: 3,
    categories: 6,
    users: 3,
    contractors: 4,
    certificates: 7,
    complianceItems: items.length,
    credentials: {
      admin: { email: DEMO.adminEmail, password: DEMO.adminPassword },
      staff: { email: DEMO.staffEmail, password: DEMO.staffPassword },
      viewer: { email: DEMO.viewerEmail, password: DEMO.viewerPassword },
    },
  };
}
