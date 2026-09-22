import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export function utcMonth(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Commits one completed response to the durable ledger and month aggregate.
 * The event key is generated per HTTP response, so retries are separate
 * traffic, while finish/close races and process replay remain idempotent.
 */
export async function recordDownloadBytes(clientId: number, bytes: number, eventId: string): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes === 0) return;
  const month = utcMonth();
  await db.transaction(async (tx) => {
    const inserted = await tx.execute(sql`
      INSERT INTO storage_download_events (event_id, client_id, month, bytes)
      VALUES (${eventId}, ${clientId}, ${month}, ${bytes})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id
    `);
    if ((inserted.rows as unknown[]).length === 0) return;
    await tx.execute(sql`
      INSERT INTO storage_download_months (client_id, month, bytes, updated_at)
      VALUES (${clientId}, ${month}, ${bytes}, now())
      ON CONFLICT (client_id, month)
      DO UPDATE SET bytes = storage_download_months.bytes + EXCLUDED.bytes, updated_at = now()
    `);
  });
}

export async function getMonthlyDownloadBytes(clientId: number, month = utcMonth()): Promise<number> {
  const result = await db.execute(sql`
    SELECT bytes FROM storage_download_months WHERE client_id = ${clientId} AND month = ${month}
  `);
  const value = Number((result.rows as any[])[0]?.bytes ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Stored download usage is out of range");
  return value;
}

/** Keep the immutable audit ledger bounded while retaining recent billing history. */
export async function cleanupDownloadLedger(retainMonths = 15): Promise<void> {
  if (!Number.isInteger(retainMonths) || retainMonths < 1) return;
  await db.execute(sql`
    DELETE FROM storage_download_events
    WHERE created_at < (date_trunc('month', now()) - (${retainMonths} || ' months')::interval)
  `);
}

export function createDownloadMeter(clientId: number) {
  const eventId = randomUUID();
  let bytes = 0;
  let committed = false;
  return {
    eventId,
    add(chunk: Buffer | Uint8Array | string) {
      if (typeof chunk === "string") bytes += Buffer.byteLength(chunk);
      else bytes += chunk.byteLength;
    },
    async commit() {
      if (committed) return;
      committed = true;
      await recordDownloadBytes(clientId, bytes, eventId);
    },
  };
}