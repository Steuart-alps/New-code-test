import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

const CONSULTANT_EMAIL = process.env.CONSULTANT_EMAIL ?? "consultant@complytrack.com";
const CONSULTANT_PASSWORD = process.env.CONSULTANT_PASSWORD ?? "ChangeMe123!";
const CONSULTANT_NAME = process.env.CONSULTANT_NAME ?? "H&S Consultant";

async function seed() {
  const existing = await db.select().from(usersTable).where(eq(usersTable.email, CONSULTANT_EMAIL));
  if (existing.length > 0) {
    console.log(`Consultant account already exists: ${CONSULTANT_EMAIL}`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(CONSULTANT_PASSWORD, 12);
  await db.insert(usersTable).values({
    email: CONSULTANT_EMAIL,
    name: CONSULTANT_NAME,
    role: "consultant",
    clientId: null,
    departmentId: null,
    active: true,
    passwordHash,
  });

  console.log("✅ Consultant account created:");
  console.log(`   Email:    ${CONSULTANT_EMAIL}`);
  console.log(`   Password: ${CONSULTANT_PASSWORD}`);
  console.log("\n⚠️  Change the password after first login!");
}

seed().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
