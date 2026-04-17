import { Router } from "express";
import { seedDemo } from "../lib/seedDemo";
import { logger } from "../lib/logger";

const router = Router();

// One-shot demo seed endpoint, gated by a secret token.
// POST /api/admin/seed-demo  with header  Authorization: Bearer <DEMO_SEED_TOKEN>
router.post("/admin/seed-demo", async (req, res) => {
  const token = process.env.DEMO_SEED_TOKEN;
  if (!token) {
    return res.status(503).json({ error: "Seed endpoint disabled (no token configured)." });
  }

  const auth = req.headers.authorization ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (presented !== token) {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const result = await seedDemo();
    logger.info({ result }, "Demo data seeded");
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, "Demo seed failed");
    res.status(500).json({ error: err.message ?? "Seed failed" });
  }
});

export default router;
