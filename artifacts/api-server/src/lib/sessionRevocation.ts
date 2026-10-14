import { createHash } from "crypto";
import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * Stored form of a high-entropy bearer credential (mobile session token or
 * password reset link). The prefix marks rows written in hashed form; rows
 * without it are legacy plaintext and are hashed in place by the runtime
 * migrations, so a database copy never holds a usable credential.
 */
export function hashStoredCredential(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Values a presented credential may match in storage: its hashed form, plus
 * the legacy plaintext form for rows written by an older instance during a
 * rolling deploy (those are hashed on the next start-up). Only well-formed
 * 64-hex tokens are ever compared as plaintext, so a stolen "sha256:..." row
 * value can never be replayed as a credential.
 */
export function storedCredentialCandidates(token: string): string[] {
  const hashed = hashStoredCredential(token);
  return /^[a-f0-9]{64}$/i.test(token) ? [hashed, token] : [hashed];
}

/**
 * Sign a user out everywhere: delete their web sessions (connect-pg-simple
 * keeps the session JSON in sessions.sess; pending two-factor sessions are
 * included) and every mobile bearer token. `exceptSessionId` keeps the
 * caller's own web session, e.g. when they changed their own password.
 */
export async function revokeUserSessions(
  userId: number,
  opts: { exceptSessionId?: string | null } = {},
): Promise<void> {
  const id = String(userId);
  const keep = opts.exceptSessionId ?? null;
  await db.execute(sql`
    DELETE FROM sessions
    WHERE (sess->>'userId' = ${id}
        OR sess->>'pending2faUserId' = ${id}
        OR sess->>'pending2faSetupUserId' = ${id}
        OR sess->>'pendingPasskeyUserId' = ${id})
      AND (${keep}::text IS NULL OR sid <> ${keep}::text)
  `);
  await db.execute(sql`DELETE FROM mobile_sessions WHERE user_id = ${userId}`);
}

/**
 * Issue a fresh session id at sign-in so a session id planted before
 * authentication (session fixation) never becomes an authenticated session.
 * Everything in the old session, including its CSRF token, is discarded; the
 * web client fetches a new CSRF token after signing in.
 */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

/** Regenerate the session and mark it as signed in to `userId`. */
export async function startAuthenticatedSession(req: Request, userId: number): Promise<void> {
  await regenerateSession(req);
  req.session.userId = userId;
}
