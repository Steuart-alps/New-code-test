/**
 * Demo seed — creates a realistic demo client + one user per role so the login
 * page can offer one-click "Try as [role]" buttons.
 *
 * Safe to run multiple times: skips everything if the demo slug already exists.
 */
import { db } from "@workspace/db";
import {
  clientsTable,
  usersTable,
  sitesTable,
  fixTrackIssuesTable,
  consultantClientsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

const DEMO_SLUG     = "complytrack-demo";
const DEMO_PASSWORD = "Demo1234!";

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

export default async function seedDemo() {
  // Wipe any previous (possibly partial) demo data first — cascade handles sites/users
  const existing = await db
    .select({ id: clientsTable.id })
    .from(clientsTable)
    .where(eq(clientsTable.slug, DEMO_SLUG));

  if (existing.length > 0) {
    await db.delete(clientsTable).where(eq(clientsTable.slug, DEMO_SLUG));
    console.log("   ↩ Removed previous demo data (fresh seed)");
  }

  console.log("🌱  Seeding demo accounts…");

  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // ── Demo client ────────────────────────────────────────────────────────────
  const [client] = await db
    .insert(clientsTable)
    .values({
      name:               "The Grand Hotel",
      slug:               DEMO_SLUG,
      primaryColor:       "#162D42",
      active:             true,
      subscriptionStatus: "trial",
      trialEndsAt:        new Date("2099-12-31"), // perpetual trial → all services
    })
    .returning();

  console.log(`   ✔ Client created: "${client.name}" (id=${client.id})`);

  // ── Sites ──────────────────────────────────────────────────────────────────
  const siteRows = await db
    .insert(sitesTable)
    .values([
      { clientId: client.id, name: "Main Building",      address: "1 Grand Street, London" },
      { clientId: client.id, name: "Pool Complex",       address: "1a Grand Street, London" },
      { clientId: client.id, name: "Restaurant & Bar",   address: "2 Grand Street, London" },
    ])
    .returning();

  const [sitMain, sitPool, sitRest] = siteRows;
  console.log(`   ✔ ${siteRows.length} sites created`);

  // ── Consultant user (manages the demo client) ──────────────────────────────
  const [consultant] = await db
    .insert(usersTable)
    .values({
      email:        "consultant@demo.complytrack.app",
      name:         "Demo Consultant",
      role:         "consultant",
      clientId:     null,
      active:       true,
      passwordHash: hash,
    })
    .returning({ id: usersTable.id });

  await db.insert(consultantClientsTable).values({
    userId:   consultant.id,
    clientId: client.id,
  });

  // ── Client users ───────────────────────────────────────────────────────────
  await db.insert(usersTable).values([
    {
      email:                "admin@demo.complytrack.app",
      name:                 "Demo Admin",
      role:                 "client_admin",
      clientId:             client.id,
      active:               true,
      passwordHash:         hash,
      isMaintenanceManager: false,
    },
    {
      email:                "staff@demo.complytrack.app",
      name:                 "Demo Staff",
      role:                 "client_staff",
      clientId:             client.id,
      active:               true,
      passwordHash:         hash,
      isMaintenanceManager: false,
    },
    {
      email:                "viewer@demo.complytrack.app",
      name:                 "Demo Viewer",
      role:                 "client_viewer",
      clientId:             client.id,
      active:               true,
      passwordHash:         hash,
      isMaintenanceManager: false,
    },
    {
      email:                "maintenance@demo.complytrack.app",
      name:                 "Demo Maintenance",
      role:                 "client_staff",
      clientId:             client.id,
      active:               true,
      passwordHash:         hash,
      isMaintenanceManager: true,
    },
  ]);

  console.log(`   ✔ 5 demo users created (password: ${DEMO_PASSWORD})`);

  // ── FixTrack issues (mix of statuses / priorities / ages) ─────────────────
  await db.insert(fixTrackIssuesTable).values([
    {
      clientId:     client.id,
      siteId:       sitMain.id,
      title:        "Gas boiler — no heating or hot water",
      issueType:    "gas",
      location:     "Basement Plant Room",
      description:  "Boiler showing fault code E3. No heating or hot water across the building.",
      priority:     "urgent",
      status:       "reported",
      reportedBy:   "Demo Admin",
      reportedDate: daysAgo(22),
      mediaUrls:    [],
    },
    {
      clientId:     client.id,
      siteId:       sitMain.id,
      title:        "Car park light column — exposed wiring at base",
      issueType:    "electrical",
      location:     "East Car Park",
      description:  "Base of column shows exposed cabling. Cordon placed. Urgent repair needed.",
      priority:     "urgent",
      status:       "reported",
      reportedBy:   "Demo Maintenance",
      reportedDate: daysAgo(1),
      mediaUrls:    [],
    },
    {
      clientId:     client.id,
      siteId:       sitMain.id,
      title:        "Fire door not self-closing — 2nd floor corridor",
      issueType:    "safety_hazard",
      location:     "2nd Floor Corridor",
      description:  "Fire door hinge damaged — door no longer closes fully. Fire risk.",
      priority:     "high",
      status:       "reported",
      reportedBy:   "Demo Staff",
      reportedDate: daysAgo(8),
      mediaUrls:    [],
    },
    {
      clientId:     client.id,
      siteId:       sitPool.id,
      title:        "Pool circulation pump intermittent fault",
      issueType:    "equipment",
      location:     "Pump Room",
      description:  "Pump cutting out every 2–3 hours. Water clarity deteriorating.",
      priority:     "high",
      status:       "in_progress",
      reportedBy:   "Demo Staff",
      reportedDate: daysAgo(5),
      assignedTo:   "Site Engineer",
      mediaUrls:    [],
    },
    {
      clientId:     client.id,
      siteId:       sitRest.id,
      title:        "Cold water leak under prep sink",
      issueType:    "plumbing",
      location:     "Prep Kitchen",
      description:  "Slow drip from compression fitting. Tray placed underneath.",
      priority:     "medium",
      status:       "in_progress",
      reportedBy:   "Demo Staff",
      reportedDate: daysAgo(3),
      mediaUrls:    [],
    },
    {
      clientId:     client.id,
      siteId:       sitRest.id,
      title:        "Kitchen extraction fan — grinding bearing noise",
      issueType:    "hvac",
      location:     "Main Kitchen",
      description:  "Loud grinding from extraction fan. Performance OK for now but worsening.",
      priority:     "medium",
      status:       "reported",
      reportedBy:   "Demo Staff",
      reportedDate: daysAgo(3),
      mediaUrls:    [],
    },
    {
      clientId:     client.id,
      siteId:       sitMain.id,
      title:        "Conference room B — projector unresponsive",
      issueType:    "it_comms",
      location:     "Conference Room B",
      description:  "Projector completely unresponsive. Power light off.",
      priority:     "low",
      status:       "in_progress",
      reportedBy:   "Demo Admin",
      reportedDate: daysAgo(10),
      assignedTo:   "AV Technician",
      mediaUrls:    [],
    },
    {
      clientId:      client.id,
      siteId:        sitPool.id,
      title:         "Pool changing room — cracked floor tiles",
      issueType:     "structural",
      location:      "Changing Room A",
      description:   "Two cracked tiles creating a trip hazard.",
      priority:      "medium",
      status:        "resolved",
      reportedBy:    "Demo Staff",
      reportedDate:  daysAgo(14),
      resolvedDate:  daysAgo(3),
      solutionNotes: "Tiles replaced by Marble Repairs Ltd. Area inspected and signed off.",
      mediaUrls:     [],
    },
    {
      clientId:      client.id,
      siteId:        sitRest.id,
      title:         "Walk-in fridge thermostat replaced",
      issueType:     "equipment",
      location:      "Cold Store",
      description:   "Thermostat showing wrong temperature, unit running warm.",
      priority:      "high",
      status:        "resolved",
      reportedBy:    "Demo Admin",
      reportedDate:  daysAgo(21),
      resolvedDate:  daysAgo(7),
      solutionNotes: "Thermostat replaced under warranty. Temperatures normal.",
      mediaUrls:     [],
    },
  ]);

  console.log(`   ✔ 9 demo FixTrack issues created`);

  console.log(`
🎉  Demo seed complete!

   Password for all accounts: ${DEMO_PASSWORD}

   consultant@demo.complytrack.app   — Consultant (manages clients)
   admin@demo.complytrack.app        — Client Admin
   staff@demo.complytrack.app        — Staff Member
   viewer@demo.complytrack.app       — Viewer (read-only)
   maintenance@demo.complytrack.app  — Maintenance Manager (FixTrack)
`);
}
