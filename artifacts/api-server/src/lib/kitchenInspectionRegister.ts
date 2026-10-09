import { db } from "@workspace/db";
import { SQL, sql } from "drizzle-orm";

type Row = Record<string, any>;
const dateOf = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const MAX_ROWS = 10_000;
const MAX_BYTES = 25 * 1024 * 1024;
export class KitchenRegisterTooLarge extends Error {}

/** Quotes CSV correctly and prevents spreadsheet formula execution, including headers. */
export function inspectionCsv(rows: Row[], fallbackHeaders = ["inspection_date", "site_id", "record_id"]) {
  const headers = rows.length ? [...new Set(rows.flatMap(row => Object.keys(row)))] : fallbackHeaders;
  const cell = (value: unknown) => {
    let text = value == null ? "" : value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [headers.map(cell).join(","), ...rows.map(row => headers.map(key => cell(row[key])).join(","))].join("\r\n") + "\r\n";
}

export async function kitchenInspectionRegister(clientId: number, siteId: number, from: string, to: string) {
  const files: Record<string, string> = {};
  let bytes = 0;
  const add = (name: string, rows: Row[]) => {
    if (rows.length > MAX_ROWS) throw new KitchenRegisterTooLarge("Too many records; choose a shorter date range");
    const content = inspectionCsv(rows);
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_BYTES) throw new KitchenRegisterTooLarge("The register exceeds 25 MiB; choose a shorter date range");
    files[name] = content;
  };
  const load = async (query: SQL) => (await db.execute(query)).rows as Row[];
  const diaries = await load(sql`SELECT * FROM food_safety_records
    WHERE client_id = ${clientId} AND site_id = ${siteId}
      AND record_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY record_date, id LIMIT 10001`);
  add("daily-diaries.csv", diaries.map(row => ({ inspection_date: dateOf(row.record_date), ...row })));
  const temperatures: Row[] = [];
  for (const diary of diaries) {
    for (const section of ["cold_food", "deliveries", "hot_temperature", "cooling", "reheating", "hot_holding", "sous_vide"]) {
      const rows = Array.isArray(diary[section]) ? diary[section] as Row[] : [];
      rows.forEach((row, index) => temperatures.push({
        inspection_date: dateOf(diary.record_date), site_id: siteId, diary_id: diary.id,
        section, row_number: index + 1, observation: row,
        performed_by: diary.performed_by, corrective_notes: diary.correctives,
        manager_signature: diary.manager_signature, submitted_at: diary.submitted_at,
        ...Object.fromEntries(Object.entries(row).map(([field, value]) => [`reading_${field}`, value])),
      }));
    }
  }
  add("daily-temperatures.csv", temperatures);
  const weekly = await load(sql`SELECT * FROM kitchen_weekly_records
    WHERE client_id = ${clientId} AND site_id = ${siteId}
      AND week_commencing BETWEEN ${from}::date AND ${to}::date
    ORDER BY week_commencing, id LIMIT 10001`);
  add("weekly-reviews.csv", weekly.map(row => ({ inspection_date: dateOf(row.week_commencing), ...row })));
  const probes = await load(sql`SELECT * FROM kitchen_probe_checks
    WHERE client_id = ${clientId} AND site_id = ${siteId}
      AND check_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY check_date, id LIMIT 10001`);
  add("probe-checks.csv", probes.map(row => ({ inspection_date: dateOf(row.check_date), ...row })));
  const checklists = await load(sql`SELECT * FROM daily_checklists
    WHERE client_id = ${clientId} AND site_id = ${siteId}
      AND check_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY check_date, id LIMIT 10001`);
  add("daily-checklists.csv", checklists.map(row => ({ inspection_date: dateOf(row.check_date), ...row })));
  const submissions = await load(sql`SELECT * FROM daily_checklist_submissions
    WHERE client_id = ${clientId} AND site_id = ${siteId}
      AND checklist_date BETWEEN ${from} AND ${to}
    ORDER BY checklist_date, id LIMIT 10001`);
  add("checklist-submissions-and-signoffs.csv", submissions.map(row => ({ inspection_date: dateOf(row.checklist_date), ...row })));
  const signoffs = await load(sql`SELECT * FROM daily_manager_signoffs
    WHERE client_id = ${clientId} AND site_id = ${siteId}
      AND signoff_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY signoff_date, id LIMIT 10001`);
  add("manager-signoffs.csv", signoffs.map(row => ({ inspection_date: dateOf(row.signoff_date), ...row })));
  // Source-linked actions use the date of the failed diary, not the later closure date.
  // Manual actions use their creation day in the UK operating timezone.
  const actions = await load(sql`SELECT a.*,
      COALESCE(d.record_date, (a.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London')::date) AS inspection_date
    FROM track_actions a LEFT JOIN food_safety_records d ON
      left(a.source_kind, 20) = 'kitchen_temperature_' AND a.source_record_id = d.id
      AND d.client_id = ${clientId} AND d.site_id = ${siteId}
    WHERE a.client_id = ${clientId} AND a.site_id = ${siteId} AND a.module = 'kitchen'
      AND (CASE WHEN left(a.source_kind, 20) = 'kitchen_temperature_' THEN d.record_date
        ELSE (a.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London')::date END)
        BETWEEN ${from}::date AND ${to}::date
    ORDER BY inspection_date, a.id LIMIT 10001`);
  add("corrective-actions.csv", actions.map(row => ({ ...row, inspection_date: dateOf(row.inspection_date) })));
  const failures = await load(sql`SELECT e.id AS audit_id, e.entity_id AS action_id,
      d.record_date AS inspection_date, d.site_id, e.metadata->'failure' AS failed_observation
    FROM audit_events e JOIN track_actions a ON a.id = e.entity_id AND a.client_id = ${clientId}
      AND a.site_id = ${siteId} AND a.module = 'kitchen'
    JOIN food_safety_records d ON d.id = a.source_record_id AND d.client_id = ${clientId} AND d.site_id = ${siteId}
    WHERE e.client_id = ${clientId} AND e.entity_type = 'track_action' AND e.action = 'temperature_failure_created'
      AND d.record_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY d.record_date, e.id LIMIT 10001`);
  add("failures.csv", [
    ...failures.map(row => ({ ...row, inspection_date: dateOf(row.inspection_date), category: "temperature" })),
    ...weekly.filter(row => row.overall_result === "fail").map(row => ({
      inspection_date: dateOf(row.week_commencing), site_id: siteId, category: "weekly_review",
      record_id: row.id, failed_observation: row.checks, corrective_details: row.deviations,
    })),
    ...probes.filter(row => row.overall_result === "fail").map(row => ({
      inspection_date: dateOf(row.check_date), site_id: siteId, category: "probe_check",
      record_id: row.id, failed_observation: row.probes, corrective_details: row.notes,
    })),
  ]);
  const actionIds = actions.map(row => Number(row.id));
  // Never export free-standing evidence belonging to an unrelated period.
  const evidence = actionIds.length ? await load(sql`SELECT e.*, a.inspection_date
    FROM track_evidence e JOIN (
      SELECT a.id, COALESCE(d.record_date, (a.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London')::date) AS inspection_date
      FROM track_actions a LEFT JOIN food_safety_records d ON left(a.source_kind, 20) = 'kitchen_temperature_'
        AND d.id = a.source_record_id AND d.client_id = ${clientId} AND d.site_id = ${siteId}
      WHERE a.client_id = ${clientId} AND a.site_id = ${siteId} AND a.module = 'kitchen'
    ) a ON a.id = e.action_id
    WHERE e.client_id = ${clientId} AND e.site_id = ${siteId} AND e.module = 'kitchen'
      AND a.id IN (${sql.join(actionIds.map(id => sql`${id}`), sql`, `)})
      AND a.inspection_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY a.inspection_date, e.id LIMIT 10001`) : [];
  add("verification-evidence.csv", evidence.map(row => ({ ...row, inspection_date: dateOf(row.inspection_date) })));
  return files;
}