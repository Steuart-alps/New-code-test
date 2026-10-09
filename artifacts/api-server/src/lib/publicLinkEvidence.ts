import type { Request } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { digestBearerToken } from "./bearerTokens";

export type PublicLinkKind = "sign_off" | "contractor_portal" | "fix_track_action" | "fix_track_quote";

/**
 * Persist an access event without retaining the bearer credential or request
 * metadata that could identify a person. Route templates are recorded rather
 * than concrete paths so tokens and resource IDs never enter the audit event.
 */
export async function recordPublicLinkAccess(
  req: Request,
  input: {
    kind: PublicLinkKind;
    clientId: number;
    token: string;
  },
): Promise<void> {
  const routePath = typeof req.route?.path === "string" ? req.route.path : "unknown";
  const action = `${req.method.toUpperCase()} ${routePath}`.slice(0, 200);

  await db.execute(sql`
    INSERT INTO public_link_access_evidence
      (client_id, link_type, token_fingerprint, action)
    VALUES
      (${input.clientId}, ${input.kind}, ${digestBearerToken(input.token)}, ${action})
  `);
}