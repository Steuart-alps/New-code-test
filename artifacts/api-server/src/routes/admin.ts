import { Router } from "express";
import { seedDemo } from "../lib/seedDemo";
import { ensureServicePrices } from "../lib/services";
import { requireAuth, requireConsultant } from "../middleware/requireAuth";
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

// Ensure a Stripe price exists for every activatable module so clients can
// turn any of them on from their billing page. Idempotent — safe to call
// repeatedly; only creates prices for modules that are currently missing one.
// Consultant-only (platform administration action).
// POST /api/admin/ensure-service-prices
router.post("/admin/ensure-service-prices", requireAuth, requireConsultant, async (_req, res) => {
  try {
    const result = await ensureServicePrices();
    logger.info({ result }, "Ensured Stripe service prices");
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, "Ensure service prices failed");
    res.status(500).json({ error: err.message ?? "Failed to ensure service prices" });
  }
});

export default router;
