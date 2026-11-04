/**
 * Manager-issued contractor portal links and the portal reminder drafts that
 * carry them in the contractor email queue.
 *
 * Each portal reminder draft carries its own reminder link (an encrypted
 * payload; only digests reach the database). A reminder link works only while
 * the manager-issued link it was bound to is the contractor's current,
 * unrevoked link. The policy for unsent drafts:
 *
 * - Reissue: every unsent draft is relinked in the same transaction to a new
 *   reminder link bound to the new issuance. A pending draft keeps its content
 *   and still needs a manager's approval. A draft that a manager approved but
 *   that has not been sent yet goes back to pending with its approval cleared:
 *   an approval only ever sends the link that was current when it was given.
 * - Revoke: every unsent draft is cancelled with a reason. Nothing is
 *   relinked, and a later reissue does not bring them back.
 * - Sending: an approved portal draft is sent only inside a transaction that
 *   holds a share lock on the contractor's link row, after re-reading the
 *   draft and checking its link is still current. Reissue and revoke wait for
 *   a send already in progress (its link was valid when sent); a send that
 *   lost the race refuses with a 409 instead of sending a dead link.
 *
 * Lock order is always contractor, then the contractor's portal link row, then
 * queue rows in id order: the same order the scheduler uses.
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { db } from "@workspace/db";
import { digestBearerToken, newBearerToken, encryptTokenPayload, decryptTokenPayload } from "./bearerTokens";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db;

/** How long a reminder link works, from when its draft was (re)built. */
export const PORTAL_REMINDER_LINK_DAYS = 90;

export interface PortalLinkRow {
  id: number;
  token_hash: string;
  revoked_at: Date | null;
}

export interface UnsentPortalDraft {
  id: number;
  status: "pending" | "approved" | "sending";
}

/** Lock a contractor, its portal link row (if any) and its unsent portal
 *  reminder drafts, in that order. Returns null when the contractor is not
 *  in this client. */
export async function lockPortalLinkAndDrafts(tx: Tx, clientId: number, contractorId: number) {
  const contractor = (await tx.execute(sql`SELECT id, client_id FROM contractors
    WHERE id=${contractorId} AND client_id=${clientId} FOR UPDATE`)).rows[0];
  if (!contractor) return null;
  const link = (await tx.execute(sql`SELECT id, token_hash, revoked_at FROM contractor_portal_tokens
    WHERE contractor_id=${contractorId} FOR UPDATE`)).rows[0] as unknown as PortalLinkRow | undefined;
  const drafts = (await tx.execute(sql`SELECT id, status FROM contractor_email_queue
    WHERE client_id=${clientId} AND contractor_id=${contractorId}
      AND entity_type='contractor_compliance' AND status IN ('pending','approved','sending')
    ORDER BY id FOR UPDATE`)).rows as unknown as UnsentPortalDraft[];
  return { link: link ?? null, drafts };
}

/**
 * Give every unsent draft a new reminder link bound to the link row's current
 * token. Pending drafts stay pending; approved or claimed drafts return to
 * pending for a fresh approval (or are withdrawn if another draft for the
 * contractor already holds the one active slot). Each relinked draft gets a
 * new delivery idempotency key, so a provider never deduplicates it against
 * an earlier attempt that carried the old link.
 */
export async function relinkUnsentPortalDrafts(
  tx: Tx,
  link: { id: number; token_hash: string },
  drafts: UnsentPortalDraft[],
  appUrl: string,
  now: Date = new Date(),
): Promise<{ relinked: number[]; approvalsWithdrawn: number[]; withdrawn: number[] }> {
  const relinked: number[] = [];
  const approvalsWithdrawn: number[] = [];
  const withdrawn: number[] = [];
  // The queue allows one pending-or-sending draft per contractor. Legacy
  // "approved" drafts sit outside that slot; one may move back to pending
  // only when no other draft already holds it.
  let slotTaken = drafts.some(draft => draft.status !== "approved");
  for (const draft of drafts) {
    if (draft.status === "approved") {
      if (slotTaken) {
        await tx.execute(sql`UPDATE contractor_email_queue SET status='cancelled',
          last_error='Portal link reissued before this approved reminder was sent; withdrawn, not sent', updated_at=now()
          WHERE id=${draft.id} AND status='approved'`);
        withdrawn.push(draft.id);
        continue;
      }
      slotTaken = true;
    }
    const token = newBearerToken();
    await tx.execute(sql`INSERT INTO contractor_portal_reminder_tokens
      (portal_token_id, issuance_hash, token_hash, expires_at)
      VALUES (${link.id}, ${link.token_hash}, ${digestBearerToken(token)},
        ${new Date(now.getTime() + PORTAL_REMINDER_LINK_DAYS * 86_400_000)})`);
    const encrypted = encryptTokenPayload({ portal: `${appUrl}/contractor-portal/${token}` });
    const suffix = randomBytes(6).toString("hex");
    if (draft.status === "pending") {
      await tx.execute(sql`UPDATE contractor_email_queue SET encrypted_token_payload=${encrypted},
        idempotency_key=${sql`regexp_replace(idempotency_key, ':relink-[0-9a-f]+$', '')`} || ${`:relink-${suffix}`},
        updated_at=now()
        WHERE id=${draft.id} AND status='pending'`);
      relinked.push(draft.id);
    } else {
      await tx.execute(sql`UPDATE contractor_email_queue SET encrypted_token_payload=${encrypted},
        idempotency_key=${sql`regexp_replace(idempotency_key, ':relink-[0-9a-f]+$', '')`} || ${`:relink-${suffix}`},
        status='pending', approved_by=NULL, approved_at=NULL, sent_by=NULL,
        last_error='Portal link reissued before this reminder was sent, so it was not sent. It now carries the new link; approve it again to send it.',
        updated_at=now()
        WHERE id=${draft.id} AND status=${draft.status}`);
      relinked.push(draft.id);
      approvalsWithdrawn.push(draft.id);
    }
  }
  return { relinked, approvalsWithdrawn, withdrawn };
}

/** Cancel every unsent draft: a revoked link must not be emailed. */
export async function cancelUnsentPortalDrafts(tx: Tx, drafts: UnsentPortalDraft[]): Promise<number[]> {
  if (!drafts.length) return [];
  const cancelled = await tx.execute(sql`UPDATE contractor_email_queue SET status='cancelled',
    last_error='Portal link revoked by a manager; not sent', updated_at=now()
    WHERE id IN (${sql.join(drafts.map(draft => sql`${draft.id}`), sql`, `)})
      AND status IN ('pending','approved','sending')
    RETURNING id`);
  return (cancelled.rows as any[]).map(row => Number(row.id));
}

export type PortalLinkChange = "reissued" | "revoked" | "invalid";

/** The draft's link stopped being current between approval and sending. */
export class PortalLinkChangedError extends Error {
  constructor(readonly change: PortalLinkChange) {
    super(
      change === "revoked"
        ? "The contractor's portal link was revoked before this reminder was sent, so nothing was sent and the reminder was cancelled."
        : change === "reissued"
          ? "The contractor's portal link was reissued before this reminder was sent, so nothing was sent. The reminder now carries the new link and is waiting for approval again."
          : "This reminder's portal link has expired or is no longer valid, so nothing was sent and the reminder was cancelled.",
    );
    this.name = "PortalLinkChangedError";
  }

  get code() {
    return `portal_link_${this.change}` as const;
  }
}

function portalBearer(value: string | undefined): string | null {
  if (!value) return null;
  const bearer = value.includes("/contractor-portal/") ? value.slice(value.lastIndexOf("/") + 1) : value;
  return bearer || null;
}

/**
 * Send a claimed portal reminder while its link is guaranteed current. Locks
 * the contractor's link row (shared) and the draft, re-reads the draft, checks
 * it is still this claim and that its link is valid now, then calls `send`
 * with the fresh row and marks it sent, all in one transaction. Reissue and
 * revoke take the link row exclusively, so they wait for this send and cannot
 * invalidate the link while it is being delivered.
 *
 * Throws PortalLinkChangedError (nothing sent) when the link changed after
 * the claim; any other error from `send` propagates with nothing marked sent.
 */
export async function sendPortalDraftWithCurrentLink<T>(
  database: Database,
  claim: { id: number; client_id: number; contractor_id: number; approved_at: Date | string | null },
  send: (draft: any) => Promise<T>,
): Promise<T> {
  const outcome = await database.transaction(async (tx): Promise<{ changed: PortalLinkChange } | { sent: T }> => {
    const link = (await tx.execute(sql`SELECT id, token_hash, revoked_at FROM contractor_portal_tokens
      WHERE contractor_id=${claim.contractor_id} AND client_id=${claim.client_id} FOR SHARE`)).rows[0] as unknown as PortalLinkRow | undefined;
    const draft = (await tx.execute(sql`SELECT * FROM contractor_email_queue
      WHERE id=${claim.id} AND client_id=${claim.client_id} FOR UPDATE`)).rows[0] as any;
    const sameClaim = draft?.status === "sending"
      && new Date(draft.approved_at ?? 0).getTime() === new Date(claim.approved_at ?? 0).getTime();
    if (!sameClaim) return { changed: !link || link.revoked_at ? "revoked" : "reissued" };
    if (!link || link.revoked_at) {
      // Revocation cancels unsent drafts; this covers a row it could not see.
      await cancelUnsentPortalDrafts(tx, [{ id: draft.id, status: "sending" }]);
      return { changed: "revoked" };
    }
    // A damaged or undecryptable payload throws TokenPayloadError, which the
    // caller already reports without sending.
    const bearer = portalBearer(decryptTokenPayload(draft.encrypted_token_payload ?? "").portal);
    const digest = bearer ? digestBearerToken(bearer) : null;
    const valid = digest !== null && (await tx.execute(sql`SELECT 1 FROM contractor_portal_tokens cpt
      WHERE cpt.id=${link.id} AND (
        (cpt.token_hash=${digest} AND cpt.expires_at > now())
        OR EXISTS (SELECT 1 FROM contractor_portal_reminder_tokens reminder
          WHERE reminder.portal_token_id=cpt.id AND reminder.issuance_hash=cpt.token_hash
            AND reminder.token_hash=${digest} AND reminder.expires_at > now())
      )`)).rows.length > 0;
    if (!valid) {
      await tx.execute(sql`UPDATE contractor_email_queue SET status='cancelled',
        last_error='Portal link expired or no longer valid; not sent', updated_at=now()
        WHERE id=${draft.id} AND status='sending'`);
      return { changed: "invalid" };
    }
    const result = await send(draft);
    await tx.execute(sql`UPDATE contractor_email_queue SET status='sent', sent_at=now(), updated_at=now()
      WHERE id=${draft.id} AND status='sending'`);
    return { sent: result };
  });
  // Thrown after commit, so the cancellation above is kept.
  if ("changed" in outcome) throw new PortalLinkChangedError(outcome.changed);
  return outcome.sent;
}
