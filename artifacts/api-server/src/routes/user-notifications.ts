/**
 * The signed-in user's in-app notifications for the active business
 * (lib/userNotifications.ts). Every query is scoped to req.currentUser and
 * getClientId(req), so one person's (or business's) notifications are never
 * visible to another.
 *   GET  /api/notifications            newest first, with unreadCount
 *   POST /api/notifications/:id/read   mark one read
 *   POST /api/notifications/read-all   mark all read
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { denyViewers, getClientId, requireAuth } from "../middleware/requireAuth";

const router: IRouter = Router();
const LIST_LIMIT = 30;

router.get("/notifications", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.json({ notifications: [], unreadCount: 0 });
  const userId = req.currentUser!.id;
  const [list, unread] = await Promise.all([
    db.execute(sql`
      SELECT id, module, site_id, kind, title, body, link_path, created_at, read_at
      FROM user_notifications
      WHERE user_id = ${userId} AND client_id = ${clientId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${LIST_LIMIT}
    `),
    db.execute(sql`
      SELECT count(*)::int AS n FROM user_notifications
      WHERE user_id = ${userId} AND client_id = ${clientId} AND read_at IS NULL
    `),
  ]);
  const toIso = (value: unknown) => (value == null ? null : new Date(value as string).toISOString());
  res.json({
    notifications: (list.rows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      module: row.module ?? null,
      siteId: row.site_id == null ? null : Number(row.site_id),
      kind: row.kind,
      title: row.title,
      body: row.body ?? null,
      linkPath: row.link_path ?? null,
      createdAt: toIso(row.created_at),
      readAt: toIso(row.read_at),
    })),
    unreadCount: Number((unread.rows[0] as { n?: number } | undefined)?.n ?? 0),
  });
});

router.post("/notifications/read-all", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const updated = await db.execute(sql`
    UPDATE user_notifications SET read_at = now()
    WHERE user_id = ${req.currentUser!.id} AND client_id = ${clientId} AND read_at IS NULL
    RETURNING id
  `);
  res.json({ updated: updated.rows.length });
});

router.post("/notifications/:id/read", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const updated = await db.execute(sql`
    UPDATE user_notifications SET read_at = COALESCE(read_at, now())
    WHERE id = ${id} AND user_id = ${req.currentUser!.id} AND client_id = ${clientId}
    RETURNING id
  `);
  if (updated.rows.length === 0) return res.status(404).json({ error: "Notification not found" });
  res.json({ id, read: true });
});

export default router;
