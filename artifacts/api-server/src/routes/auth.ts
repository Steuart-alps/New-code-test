import { Router } from "express";
import { z } from "zod";
import { getUserWithClientByEmail } from "../lib/auth";
import { verifyPassword } from "../lib/auth";
import { getUserById } from "../lib/auth";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/auth/login", async (req, res) => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid email or password" });
    return;
  }

  const result = await getUserWithClientByEmail(body.data.email);
  if (!result || !result.user.active) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await verifyPassword(body.data.password, result.user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  req.session.userId = result.user.id;

  const { passwordHash: _, ...safeUser } = result.user;
  res.json({
    user: safeUser,
    client: result.client,
  });
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const user = await getUserById(req.currentUser!.id);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let client = null;
  if (user.clientId) {
    const { db } = await import("@workspace/db");
    const { clientsTable } = await import("@workspace/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(clientsTable).where(eq(clientsTable.id, user.clientId));
    client = rows[0] ?? null;
  }

  res.json({ user, client });
});

export default router;
