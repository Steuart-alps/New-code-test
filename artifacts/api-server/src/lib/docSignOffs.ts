/**
 * DocTrack read-and-sign: a document marked "staff must read and sign" is a
 * task for every active staff roster member in its department (and at its
 * site, when it has one). Each signature writes a TrainTrack "signoff"
 * record and a doc_acknowledgements row linked to it, so the sign-off shows
 * in the person's training history. Annual documents give that record a
 * one-year expiry; once it expires (or the record is removed) the person
 * must sign again.
 *
 * Shared by DocTrack (staff and managers) and TrainTrack's My training page
 * (Viewers, who can only use /train-track/my-*).
 */
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { ObjectNotFoundError, ObjectOwnershipError, ObjectStorageService } from "./objectStorage";
import { respondObjectStorageDownloadUnavailable } from "./objectStorageUnavailable";
import { getObjectAclPolicy } from "./objectAcl";

const storage = new ObjectStorageService();
const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

export interface SignOffDocument {
  id: number;
  title: string;
  category: string;
  site_id: number | null;
  department: string | null;
  requires_acknowledgement: boolean;
  annual_acknowledgement: boolean;
}

export interface RosterMember {
  id: number;
  name: string;
  department: string | null;
  site_id: number | null;
}

/** A single acknowledgement to persist, always for an eligible roster entry. */
export interface ResolvedAck {
  staffRosterId: number;
  staffName: string;
  signature: string | null;
}

export async function findSignOffDocument(clientId: number, documentId: number): Promise<SignOffDocument | undefined> {
  const result = await db.execute(sql`
    SELECT id, title, category, site_id, department, requires_acknowledgement, annual_acknowledgement FROM doc_track_documents
    WHERE id = ${documentId} AND client_id = ${clientId}
    LIMIT 1
  `);
  return rowsOf<SignOffDocument>(result)[0];
}

/**
 * The sole eligibility rule for acknowledgement evidence. A roster entry must
 * be active and assigned to every document scope that is set. Keep this
 * server-side: manager payloads and staff sessions are both untrusted.
 */
export async function findEligibleRosterMember(
  clientId: number,
  document: { site_id: number | null; department: string | null },
  rosterId?: number,
  email?: string | null,
) {
  if (rosterId == null && !email) return null;
  const result = await db.execute(sql`
    SELECT id, name
    FROM staff_roster
    WHERE client_id = ${clientId}
      AND active = true
      AND (${document.department}::text IS NULL OR department = ${document.department})
      AND (${document.site_id}::integer IS NULL OR site_id = ${document.site_id})
      AND (
        ${rosterId ?? null}::integer IS NOT NULL AND id = ${rosterId ?? null}
        OR ${email ?? null}::text IS NOT NULL AND email IS NOT NULL AND lower(email) = lower(${email ?? null})
      )
    LIMIT 1
  `);
  return (result.rows ?? [])[0] as { id: number; name: string } | undefined;
}

/** One active roster entry by id (a Viewer's linked staff record). */
export async function findActiveRosterMember(clientId: number, rosterId: number): Promise<RosterMember | undefined> {
  const result = await db.execute(sql`
    SELECT id, name, department, site_id FROM staff_roster
    WHERE id = ${rosterId} AND client_id = ${clientId} AND active = true
    LIMIT 1
  `);
  return rowsOf<RosterMember>(result)[0];
}

/**
 * The documents this person must read and sign (pending) and those they have
 * a current sign-off for (completed), newest first. `scope` narrows further,
 * e.g. to the caller's active department.
 */
export async function getMyDocuments(clientId: number, roster: RosterMember, scope: SQL = sql``) {
  const result = await db.execute(sql`
    SELECT d.id, d.title, d.category, d.description, d.file_name, d.mime_type,
           d.department, s.name AS site_name, a.acknowledged_at, a.signature,
           CASE WHEN a.id IS NOT NULL
             AND (a.train_track_record_id IS NULL OR tr.id IS NOT NULL)
             AND (tr.expiry_date IS NULL OR tr.expiry_date >= CURRENT_DATE)
             THEN true ELSE false END AS is_current
    FROM doc_track_documents d
    LEFT JOIN sites s ON s.id = d.site_id AND s.client_id = d.client_id
    LEFT JOIN doc_acknowledgements a ON a.document_id = d.id
      AND a.client_id = d.client_id AND a.staff_roster_id = ${roster.id}
    LEFT JOIN train_track_records tr ON tr.id = a.train_track_record_id
      AND tr.client_id = d.client_id
    WHERE d.client_id = ${clientId} AND d.requires_acknowledgement = true
      AND (d.department IS NULL OR d.department = ${roster.department})
      AND (d.site_id IS NULL OR d.site_id = ${roster.site_id})
      ${scope}
    ORDER BY d.created_at DESC
  `);
  const rows = (result.rows ?? []) as Array<Record<string, unknown> & { id: number; is_current: boolean }>;
  const toDocument = ({ is_current: _current, ...document }: typeof rows[number]) => document;
  return {
    pending: rows.filter(row => !row.is_current).map(toDocument),
    completed: rows.filter(row => row.is_current).map(toDocument),
  };
}

/**
 * Save sign-offs for one document. The TrainTrack sign-off and the
 * acknowledgement that links to it commit together, so a failed
 * acknowledgement write leaves no orphan sign-off. Locking each staff row
 * (the public sign-off link takes the same lock) serializes concurrent
 * manager, self and public submissions for that person, so a double tap or
 * retry records one acknowledgement and one sign-off. Locks are taken in id
 * order so overlapping bulk sign-offs cannot deadlock.
 */
export async function recordDocAcknowledgements(
  clientId: number,
  doc: SignOffDocument,
  acks: ResolvedAck[],
  userId: number,
) {
  const today = new Date().toISOString().split("T")[0];
  // A payload may name the same person twice; the first entry wins.
  const byRoster = new Map<number, ResolvedAck>();
  for (const ack of acks) if (!byRoster.has(ack.staffRosterId)) byRoster.set(ack.staffRosterId, ack);
  const rosterIds = [...byRoster.keys()].sort((a, b) => a - b);

  return db.transaction(async (tx) => {
    const rows: any[] = [];
    for (const rosterId of rosterIds) {
      await tx.execute(sql`
        SELECT id FROM staff_roster WHERE id = ${rosterId} AND client_id = ${clientId} FOR UPDATE
      `);
    }
    for (const rosterId of rosterIds) {
      const ack = byRoster.get(rosterId)!;
      // Current acknowledgements are idempotent. Expired annual sign-offs (or
      // acknowledgements whose linked TrainTrack record was removed) are
      // renewed below by replacing the stale link while retaining the
      // acknowledgement row; the old TrainTrack record stays as history.
      const existing = await tx.execute(sql`
        SELECT a.id,
               CASE
                 WHEN a.train_track_record_id IS NOT NULL AND tr.id IS NULL THEN false
                 WHEN tr.expiry_date IS NOT NULL AND tr.expiry_date < CURRENT_DATE THEN false
                 ELSE true
               END AS is_current
        FROM doc_acknowledgements a
        LEFT JOIN train_track_records tr
          ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
        WHERE a.document_id = ${doc.id} AND a.client_id = ${clientId}
          AND a.staff_roster_id = ${rosterId}
        ORDER BY a.id
        LIMIT 1
      `);
      const existingAck = (existing.rows ?? [])[0] as any;
      if (existingAck?.is_current) continue;

      // Create TrainTrack signoff record.
      // When annual_acknowledgement is enabled the record gets a 1-year expiry so
      // TrainTrack's expiry reminders automatically prompt re-acknowledgement.
      const expiryDate = doc.annual_acknowledgement
        ? sql`(${today}::date + interval '1 year')::date`
        : sql`NULL::date`;
      const trainResult = await tx.execute(sql`
        INSERT INTO train_track_records
          (client_id, site_id, record_type, staff_name, staff_roster_id, training_type, document_title,
           document_type, completed_date, expiry_date, notes, signature)
        VALUES
          (${clientId}, ${doc.site_id ?? null}, 'signoff', ${ack.staffName}, ${rosterId},
           ${doc.title},
           ${doc.title}, ${doc.category}, ${today}::date,
           ${expiryDate},
           ${'Document acknowledgement via DocTrack'},
           ${ack.signature ?? null})
        RETURNING id
      `);
      const trainId = ((trainResult.rows ?? [])[0] as any)?.id ?? null;

      const ackResult = existingAck
        ? await tx.execute(sql`
            UPDATE doc_acknowledgements
            SET staff_name = ${ack.staffName},
                signature = ${ack.signature ?? null},
                acknowledged_by = ${userId},
                train_track_record_id = ${trainId},
                acknowledged_at = now()
            WHERE id = ${existingAck.id} AND client_id = ${clientId}
            RETURNING *
          `)
        : await tx.execute(sql`
            INSERT INTO doc_acknowledgements
              (document_id, client_id, staff_roster_id, staff_name, signature,
               acknowledged_by, train_track_record_id)
            VALUES
              (${doc.id}, ${clientId}, ${rosterId}, ${ack.staffName},
               ${ack.signature ?? null}, ${userId}, ${trainId})
            RETURNING *
          `);
      if ((ackResult.rows ?? [])[0]) rows.push((ackResult.rows ?? [])[0]);
    }
    return rows;
  });
}

/**
 * Answer with a short-lived download link for a DocTrack document the caller
 * may read (the route checks access first).
 */
export async function sendDocumentDownloadUrl(
  req: Request,
  res: Response,
  clientId: number,
  document: { id: number; object_path: string; file_name: string },
) {
  // Backfill ACL for legacy documents that were uploaded before the ACL check
  // was enforced. A signed URL bypasses the application's storage route, so
  // verify the final ACL here too; it must never be issued for another tenant.
  try {
    const file = await storage.getObjectEntityFile(document.object_path);
    const existingAcl = await getObjectAclPolicy(file);
    if (!existingAcl?.owner) {
      // No ACL set — this is a legacy document; backfill it for this client.
      await storage.trySetObjectEntityAclPolicy(document.object_path, {
        owner: String(clientId),
        visibility: "private",
      });
    } else if (existingAcl.owner !== String(clientId)) {
      return res.status(403).json({ error: "Object does not belong to this account" });
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return res.status(404).json({ error: "Document object not found" });
    }
    req.log.warn({ err, objectPath: document.object_path }, "Could not backfill ACL on DocTrack download");
    // Non-fatal — attempt to generate the signed URL anyway.
  }

  try {
    const downloadUrl = await storage.getSignedDownloadURL(document.object_path);
    res.json({ downloadUrl, fileName: document.file_name });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "Document object not found" });
    if (err instanceof ObjectOwnershipError) return res.status(403).json({ error: "Object does not belong to this account" });
    return respondObjectStorageDownloadUnavailable(req, res, err, "DocTrack document download", {
      documentId: document.id, clientId,
    });
  }
}
