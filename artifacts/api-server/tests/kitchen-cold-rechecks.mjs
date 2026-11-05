// A failed fridge/freezer reading asks for a re-check an hour later
// (src/lib/kitchenColdRechecks.ts): one reminder per failed reading, only
// once the hour has passed, never once the line has a re-check, and never for
// a failed re-check or a cooking line.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";
import { buildOwnedFixturePurgeSql, resolveRunId } from "./fixture-ownership.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => { if (ok) passed++; else { failures.push(`${name} — ${detail}`); console.error(`FAIL: ${name} — ${detail}`); } };

async function main() {
  const outDir = await mkdtemp(path.join(testsDir, ".build-"));
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "kitchen-cold-rechecks.entry.ts")], bundle: true, platform: "node", format: "esm",
    outfile: outFile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);` },
  });
  const { runKitchenColdRecheckJob, db, pool, clientsTable, usersTable, sql } = await import(new URL(`file://${outFile}`).href);
  const runId = resolveRunId();
  const tag = `cold-recheck-${runId}`;
  let clientId;
  try {
    const [client] = await db.insert(clientsTable).values({ name: `Cold re-check ${tag}`, slug: tag, active: true }).returning();
    clientId = client.id;
    const [owner] = await db.insert(usersTable).values({ email: `${tag}-owner@test.local`, passwordHash: "x", name: "Owner", role: "client_admin", clientId, active: true }).returning();
    const [chef] = await db.insert(usersTable).values({ email: `${tag}-chef@test.local`, passwordHash: "x", name: "Chef", role: "client_staff", clientId, active: true }).returning();
    const site = (await db.execute(sql`INSERT INTO sites (client_id, name) VALUES (${clientId}, 'Clubhouse') RETURNING id`)).rows[0];
    const coldFood = [
      { unit: "Fridge 1", tempAm: "9", tempPm: "", correctiveAction: "Moved food" },
      { unit: "Fridge 2", tempAm: "8", tempPm: "", recheckTemp: "4", correctiveAction: "Door shut" },
      { unit: "Freezer 1", tempAm: "-18", tempPm: "", recheckTemp: "-10", correctiveAction: "Defrosted" },
    ];
    const diary = (await db.execute(sql`
      INSERT INTO food_safety_records (client_id, site_id, record_date, cold_food, created_by)
      VALUES (${clientId}, ${site.id}, CURRENT_DATE, ${JSON.stringify(coldFood)}::jsonb, ${chef.id}) RETURNING id
    `)).rows[0];
    const now = new Date();
    async function failedAction(minutesAgo, failure) {
      const at = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
      const action = (await db.execute(sql`
        INSERT INTO track_actions (client_id, site_id, module, source_kind, source_record_id, provenance, severity, status, title, created_by, created_at, updated_at)
        VALUES (${clientId}, ${site.id}, 'kitchen', ${`kitchen_temperature_${tag}_${failure.rowIndex}_${failure.field}_${minutesAgo}`}, ${diary.id},
                'product_default', 'action_required', 'open', ${`Failed temperature: ${failure.label}`}, ${chef.id}, ${at}::timestamp, ${at}::timestamp)
        RETURNING id
      `)).rows[0];
      await db.execute(sql`
        INSERT INTO audit_events (client_id, actor_id, entity_type, entity_id, action, metadata, created_at)
        VALUES (${clientId}, ${chef.id}, 'track_action', ${action.id}, 'temperature_failure_created',
                ${JSON.stringify({ module: "kitchen", failure: { section: "coldFood", ...failure } })}::jsonb, ${at}::timestamp)
      `);
      return action.id;
    }
    const due = await failedAction(65, { rowIndex: 0, field: "tempAm", label: "Fridge 1", value: 9 });
    await failedAction(30, { rowIndex: 0, field: "tempPm", label: "Fridge 1", value: 8 });            // not an hour yet
    await failedAction(70, { rowIndex: 1, field: "tempAm", label: "Fridge 2", value: 8 });            // already re-checked
    await failedAction(70, { rowIndex: 2, field: "recheckTemp", label: "Freezer 1", value: -10 });    // a failed re-check
    await failedAction(600, { rowIndex: 0, field: "tempAm", label: "Fridge 1", value: 9 });           // too old to chase

    const pushes = [];
    const sendPush = async (ids) => { pushes.push(...ids); return ids.length; };
    const first = await runKitchenColdRecheckJob({ now, clientIds: [clientId], sendPush });
    const notes = (await db.execute(sql`SELECT user_id, kind, title, dedupe_key FROM user_notifications WHERE client_id = ${clientId} ORDER BY user_id`)).rows;
    check("only the failed reading an hour old is chased", first.found === 1, JSON.stringify(first));
    check("the chef who recorded it and the owner are reminded",
      JSON.stringify(notes.map(n => Number(n.user_id)).sort((a, b) => a - b)) === JSON.stringify([owner.id, chef.id].sort((a, b) => a - b)), JSON.stringify(notes));
    check("the reminder names the unit and site", notes.every(n => n.kind === "kitchen_cold_recheck" && n.title === "Re-check Fridge 1 now — Clubhouse"), JSON.stringify(notes));
    check("one reminder per failed reading", notes.every(n => n.dedupe_key === `kitchen_cold_recheck:action:${due}`), JSON.stringify(notes));
    check("reminders are pushed to the phone", pushes.length === 2, JSON.stringify(pushes));

    const again = await runKitchenColdRecheckJob({ now: new Date(now.getTime() + 5 * 60_000), clientIds: [clientId], sendPush });
    check("a later run does not remind again", again.notificationsCreated === 0, JSON.stringify(again));

    await db.execute(sql`UPDATE food_safety_records SET cold_food = jsonb_set(cold_food, '{0,recheckTemp}', '"4"') WHERE id = ${diary.id}`);
    const later = await runKitchenColdRecheckJob({ now: new Date(now.getTime() + 40 * 60_000), clientIds: [clientId], sendPush });
    check("a re-checked line is not chased", later.found === 0 && later.notificationsCreated === 0, JSON.stringify(later));
  } finally {
    let connection = null;
    try {
      connection = await pool.connect();
      if (clientId != null) await connection.query(buildOwnedFixturePurgeSql({ runId, clientIds: [clientId] }));
    } catch (err) {
      await connection?.query("ROLLBACK").catch(() => {});
      console.error("Cleanup failed:", err);
      process.exitCode = 1;
    } finally {
      connection?.release();
    }
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`kitchen cold re-check tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch(err => { console.error(err); process.exitCode = 1; });
