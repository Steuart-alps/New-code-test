// Real database claims, using a disposable client and a future date. No email
// is sent and no existing client's reminder state is touched.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-"));
let lib;
try {
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "track-summary-delivery.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);` },
  });
  lib = await import(pathToFileURL(outFile).href);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

const { db, pool, clientsTable, eq, sql, claimTrackSummaryDelivery: claim,
  markTrackSummaryDelivered: mark, releaseTrackSummaryDelivery: release } = lib;
let clientId;
try {
  const slug = `track-delivery-${Date.now()}-${process.pid}`;
  const [client] = await db.insert(clientsTable).values({
    name: "Track delivery test", slug, active: false,
  }).returning({ id: clientsTable.id });
  clientId = client.id;
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [first, competing] = await Promise.all([
    claim(clientId, "  STAFF@EXAMPLE.TEST ", future),
    claim(clientId, "staff@example.test", future),
  ]);
  assert.equal([first, competing].filter(Boolean).length, 1, "one concurrent claimant wins");
  const winner = first ?? competing;
  assert.equal(await claim(clientId, "STAFF@example.test", future), null, "active claim cannot be duplicated");
  const other = await claim(clientId, "senior@example.test", future);
  assert.ok(other, "another recipient has an independent claim");

  await release(winner);
  const retry = await claim(clientId, "staff@example.test", future);
  assert.ok(retry, "failed delivery can retry");
  await db.execute(sql`UPDATE track_summary_delivery SET claimed_at = now() - interval '16 minutes'
    WHERE id = ${retry.id}`);
  const recovered = await claim(clientId, "staff@example.test", future);
  assert.ok(recovered, "expired claim can be recovered after restart");
  assert.equal(recovered.id, retry.id, "recovery updates the existing recipient row");
  await release(retry);
  const rows = await db.execute(sql`SELECT claim_token, sent_at FROM track_summary_delivery WHERE id = ${recovered.id}`);
  assert.equal(rows.rows[0].claim_token, recovered.token, "old worker cannot release new worker's claim");
  await mark(recovered);
  await mark(other);
  assert.equal(await claim(clientId, "staff@example.test", future), null, "sent mail is never resent");
  assert.equal(await claim(clientId, "senior@example.test", future), null, "all recipient claims are independently final");
  console.log("Track summary delivery concurrency and retry tests passed");
} finally {
  if (clientId) await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await pool.end();
}