import { Router } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { denyViewers, getActiveDepartmentId, getClientId, requireAuth } from "../middleware/requireAuth";
import { visibleSiteIdsSql } from "../lib/departmentSites";
import {
  SIGNATURE_TOKEN_MINUTES,
  SIGNED_RECORD_TYPES,
  newSignatureToken,
  parseStrokes,
  pruneUnusedSignatures,
} from "../lib/recordSignatures";

// Drawn signatures on recorded checks; see lib/recordSignatures.ts.
const router = Router();

// POST /api/record-signatures — store a drawing and return the one-use token
// that the save sends in X-Record-Signature. The signer is the logged-in user.
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const strokes = parseStrokes(req.body?.strokes);
  if (!strokes) return res.status(400).json({ error: "Draw your signature in the box" });
  const user = req.currentUser!;
  const token = newSignatureToken();
  await pruneUnusedSignatures(clientId);
  await db.execute(sql`
    INSERT INTO record_signatures (client_id, token, user_id, signer_name, strokes)
    VALUES (${clientId}, ${token}, ${user.id}, ${user.name}, ${JSON.stringify(strokes)}::jsonb)
  `);
  res.status(201).json({ token, expiresInMinutes: SIGNATURE_TOKEN_MINUTES });
});

const listQuery = z.object({
  recordType: z.string().refine(type => SIGNED_RECORD_TYPES.has(type)),
  ids: z.string().regex(/^\d+(,\d+){0,199}$/),
});

// GET /api/record-signatures?recordType=fire_safety_check&ids=1,2,3 — the
// signatures on those records, oldest first, for history lists. Staff limited
// to a department see only signatures on records at sites they can see.
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query" });
  const ids = [...new Set(parsed.data.ids.split(",").map(Number))].filter(Number.isSafeInteger);
  const departmentId = getActiveDepartmentId(req);
  const departmentFilter = departmentId === null
    ? sql``
    : sql`AND (rs.site_id IS NULL OR rs.site_id IN (${visibleSiteIdsSql(clientId, departmentId)}))`;
  const result = await db.execute(sql`
    SELECT rs.record_type, rs.record_id, rs.signer_name, rs.signed_at, rs.strokes
    FROM record_signatures rs
    WHERE rs.client_id = ${clientId} AND rs.record_type = ${parsed.data.recordType}
      AND rs.record_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
      ${departmentFilter}
    ORDER BY rs.signed_at, rs.id
  `);
  res.json((result.rows ?? []).map((row: any) => ({
    recordType: row.record_type,
    recordId: row.record_id,
    signerName: row.signer_name,
    signedAt: row.signed_at instanceof Date ? row.signed_at.toISOString() : row.signed_at,
    strokes: row.strokes,
  })));
});

export default router;
