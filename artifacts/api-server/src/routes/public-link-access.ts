import { Router } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { ListPublicLinkAccessQueryParams, ListPublicLinkAccessResponse } from "@workspace/api-zod";
import { getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";
import type { PublicLinkKind } from "../lib/publicLinkEvidence";

// Manager review of public_link_access_evidence (lib/publicLinkEvidence.ts).
// Rows hold only the tenant, link type, a SHA-256 token fingerprint and the
// Express route template, so nothing here can reveal a usable link. The full
// fingerprint stays server-side too: callers get an 8-character reference that
// is enough to tell repeat use of one link apart from another link.

const router = Router();

// Labels for the route templates the public routers record (req.route.path).
// Unknown templates still list, as "Other link activity", so a new public
// route never hides evidence from managers.
const ACTIVITY_LABELS: Record<PublicLinkKind, Record<string, string>> = {
  sign_off: {
    "GET /:token/info": "Opened the sign-off page",
    "GET /:token/departments": "Listed departments",
    "GET /:token/staff": "Listed staff names",
    "GET /:token/documents": "Viewed documents to sign",
    "GET /:token/documents/:docId/download": "Downloaded a document",
    "POST /:token/acknowledge": "Signed a document",
  },
  contractor_portal: {
    "GET /:token": "Opened the contractor portal",
    "PUT /:token": "Updated contractor details",
    "POST /:token/upload-url": "Started a certificate upload",
    "POST /:token/certificates": "Added a certificate",
    "GET /:token/certificates/:certId/download": "Downloaded a certificate",
    "DELETE /:token/certificates/:certId": "Removed a certificate",
  },
  fix_track_action: {
    "GET /:token": "Opened the job link",
    "POST /:token/booked": "Confirmed a booking",
    "POST /:token": "Marked the job complete",
    "POST /:token/upload-url": "Started a completion photo upload",
  },
  fix_track_quote: {
    "GET /:token": "Opened the quote request",
    "POST /:token": "Submitted a quote",
  },
};

export function activityLabel(linkType: PublicLinkKind, action: string): string {
  return ACTIVITY_LABELS[linkType]?.[action] ?? "Other link activity";
}

// Keyset cursor over (created_at, id) newest first. created_at keeps
// Postgres microseconds as text so no row is skipped or repeated between pages.
type Cursor = { t: string; id: number };
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.t !== "string" || !CURSOR_TIME.test(parsed.t)) return null;
    if (!Number.isSafeInteger(parsed.id) || (parsed.id as number) < 1) return null;
    return { t: parsed.t, id: parsed.id as number };
  } catch {
    return null;
  }
}

function parseInstant(value: string | undefined): Date | null | undefined {
  if (value === undefined || value === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type EvidenceRow = {
  id: string | number;
  link_type: PublicLinkKind;
  token_fingerprint: string;
  action: string;
  created_at: string | Date;
  cursor_time: string;
};

router.get("/", requireAuth, requireClientAdmin, async (req, res) => {
  const parsed = ListPublicLinkAccessQueryParams.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid filters" });
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { linkType, actionType, cursor: rawCursor } = parsed.data;
  const limit = parsed.data.limit ?? 50;
  if (!Number.isInteger(limit)) return res.status(400).json({ error: "Invalid filters" });
  const from = parseInstant(parsed.data.from);
  const to = parseInstant(parsed.data.to);
  if (from === null || to === null) return res.status(400).json({ error: "Invalid date range" });
  const cursor = rawCursor ? decodeCursor(rawCursor) : undefined;
  if (cursor === null) return res.status(400).json({ error: "Invalid cursor" });

  // Tenant first, from the authenticated session (enforceClientAccess has
  // already rejected a consultant's unlinked clientId); never from the row.
  const conditions: SQL[] = [sql`client_id = ${clientId}`];
  if (linkType) conditions.push(sql`link_type = ${linkType}`);
  if (actionType === "view") conditions.push(sql`action LIKE 'GET %'`);
  if (actionType === "submit") conditions.push(sql`action NOT LIKE 'GET %'`);
  if (from) conditions.push(sql`created_at >= ${from.toISOString()}::timestamptz`);
  if (to) conditions.push(sql`created_at < ${to.toISOString()}::timestamptz`);
  if (cursor) conditions.push(sql`(created_at, id) < (${cursor.t}::timestamptz, ${cursor.id})`);

  const result = await db.execute(sql`
    SELECT id, link_type, token_fingerprint, action, created_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM public_link_access_evidence
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `);
  const rows = (result.rows ?? []) as unknown as EvidenceRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ t: last.cursor_time, id: Number(last.id) }) : null;

  res.json(ListPublicLinkAccessResponse.parse({
    entries: page.map(row => ({
      id: Number(row.id),
      linkType: row.link_type,
      actionType: row.action.startsWith("GET ") ? "view" : "submit",
      activity: activityLabel(row.link_type, row.action),
      linkRef: row.token_fingerprint.slice(0, 8),
      occurredAt: new Date(row.created_at),
    })),
    nextCursor,
  }));
});

export default router;
