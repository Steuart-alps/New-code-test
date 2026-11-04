import { sql, type SQL } from "drizzle-orm";

/**
 * GreenTrack hour meter readings. A machine's hours come from four places:
 * readings logged on their own (green_hour_readings), the daily pre-use check,
 * fuel logs and service records. The latest reading by date (the highest that
 * day) is the machine's current hours, so a replaced meter that starts again
 * from zero is followed once its first reading is logged.
 */

/** Hours left before a service falls due that show it as due soon. */
export const GREEN_SERVICE_DUE_SOON_HOURS = 25;
export const GREEN_MAX_HOUR_METER = 1_000_000;

/**
 * Every hour reading of one machine: `day`, `hours`, `source`, `source_id`.
 * `machineId` and `clientId` are SQL so a lateral join can pass `m.id`.
 */
export function greenHourReadingsFor(machineId: SQL, clientId: SQL): SQL {
  return sql`
    SELECT reading_date AS day, hours, 'reading'::text AS source, id AS source_id
      FROM green_hour_readings WHERE machine_id = ${machineId} AND client_id = ${clientId}
    UNION ALL
    SELECT check_date, hour_meter, 'pre_use_check', id
      FROM green_pre_use_checks WHERE machine_id = ${machineId} AND client_id = ${clientId} AND hour_meter IS NOT NULL
    UNION ALL
    SELECT log_date, engine_hours::double precision, 'fuel_log', id
      FROM green_fuel_logs WHERE machine_id = ${machineId} AND client_id = ${clientId} AND engine_hours IS NOT NULL
    UNION ALL
    SELECT service_date, hours_at_service::double precision, 'service', id
      FROM green_service_records WHERE machine_id = ${machineId} AND client_id = ${clientId} AND hours_at_service IS NOT NULL
  `;
}

/** A lateral subquery giving the machine's current `hours` and its `day`. */
export function greenCurrentHoursLateral(machineId: SQL, clientId: SQL): SQL {
  return sql`(
    SELECT r.hours, r.day FROM (${greenHourReadingsFor(machineId, clientId)}) r
    ORDER BY r.day DESC, r.hours DESC LIMIT 1
  )`;
}

/**
 * Parses an hour meter value: undefined stays undefined (not sent), null or
 * "" is null, otherwise a number from 0 to a million rounded to a tenth.
 */
export function parseHourMeter(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > GREEN_MAX_HOUR_METER) return "invalid";
  return Math.round(number * 10) / 10;
}

export type GreenServiceHoursState = "overdue" | "due_soon" | "ok" | "none";

/** Whether the latest service's "next service at" hours have been reached. */
export function greenServiceHoursState(currentHours: number | null, nextServiceHours: number | null): GreenServiceHoursState {
  if (nextServiceHours == null || currentHours == null) return "none";
  const left = nextServiceHours - currentHours;
  if (left <= 0) return "overdue";
  return left <= GREEN_SERVICE_DUE_SOON_HOURS ? "due_soon" : "ok";
}
