import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { logger } from "../lib/logger";

const router = Router();

const RegisterTokenBody = z.object({
  token: z.string().min(1).max(512),
  platform: z.string().max(32).optional(),
});

/**
 * POST /api/mobile/push-token
 * Registers (or refreshes) an Expo push token for the authenticated user.
 * The user + client are derived from the session/bearer token — never trusted
 * from the body. Upserts on token so re-registration reassigns the device to
 * the current user.
 */
router.post("/mobile/push-token", requireAuth, async (req, res) => {
  const body = RegisterTokenBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "A valid push token is required" });
    return;
  }
  const userId = req.currentUser!.id;
  const clientId = getClientId(req);
  const { token, platform } = body.data;

  try {
    await db.execute(sql`
      INSERT INTO push_tokens (user_id, client_id, token, platform)
      VALUES (${userId}, ${clientId}, ${token}, ${platform ?? null})
      ON CONFLICT (token) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            client_id = EXCLUDED.client_id,
            platform = EXCLUDED.platform
    `);
    res.status(204).send();
  } catch (err) {
    logger.error({ err, userId }, "Failed to register push token");
    res.status(500).json({ error: "Failed to register push token" });
  }
});

/**
 * DELETE /api/mobile/push-token
 * Unregisters a push token (called on logout). Only removes tokens owned by
 * the authenticated user to prevent cross-user deletion.
 */
router.delete("/mobile/push-token", requireAuth, async (req, res) => {
  const body = RegisterTokenBody.pick({ token: true }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "A valid push token is required" });
    return;
  }
  const userId = req.currentUser!.id;
  try {
    await db.execute(sql`
      DELETE FROM push_tokens WHERE token = ${body.data.token} AND user_id = ${userId}
    `);
    res.status(204).send();
  } catch (err) {
    logger.error({ err, userId }, "Failed to unregister push token");
    res.status(500).json({ error: "Failed to unregister push token" });
  }
});

export default router;
