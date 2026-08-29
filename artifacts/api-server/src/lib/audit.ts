import type { Request } from "express";
import { db } from "@workspace/db";
import { auditEventsTable } from "@workspace/db/schema";

/** Write-only helper. Never use this table to drive current application state. */
export async function appendAuditEvent(
  req: Request,
  input: {
    clientId: number;
    entityType: string;
    entityId: number;
    action: string;
    before?: unknown;
    after?: unknown;
    metadata?: unknown;
  },
) {
  await db.insert(auditEventsTable).values({
    ...input,
    actorId: req.currentUser?.id ?? null,
  });
}