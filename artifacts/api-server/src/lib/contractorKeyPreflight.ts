/**
 * Read-only preflight for retiring a contractor-token encryption key.
 *
 * Reports which key versions queued contractor email drafts still reference,
 * as aggregate counts by envelope format, key label and queue state. It never
 * decrypts anything, never returns payloads, links, recipients or key values,
 * and runs in a READ ONLY transaction, so it cannot change keys or rows.
 *
 * A retained key is reported safe to retire only when no draft, active or
 * historical, still names it, no legacy unversioned payload remains (those
 * may need any configured key), and the operator confirms that every
 * instance that could still write with the old key has stopped.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { describeTokenKeyConfiguration, type TokenKeyConfiguration } from "./bearerTokens";

export const ACTIVE_QUEUE_STATES = ["pending", "approved", "sending"] as const;
const KEY_LABEL = /^[A-Za-z0-9_-]{1,32}$/;

export type EnvelopeFormat = "v2" | "v1" | "legacy" | "malformed";

export interface EnvelopeCount {
  format: EnvelopeFormat;
  /** Key label named by a versioned envelope; null for legacy/malformed. */
  keyVersion: string | null;
  status: string;
  count: number;
}

export interface VersionUsage {
  keyVersion: string;
  configured: "current" | "retained" | "session" | "missing";
  active: number;
  historical: number;
  byStatus: Record<string, number>;
}

export interface RetirementAssessment {
  keyVersion: string;
  safeToRetire: boolean;
  blockers: string[];
}

export interface KeyPreflightReport {
  generatedAt: string;
  configuration: TokenKeyConfiguration;
  writersDrainedConfirmed: boolean;
  totals: { drafts: number; withCredentials: number; withoutCredentials: number };
  envelopes: EnvelopeCount[];
  versions: VersionUsage[];
  legacyUnversioned: { total: number; active: number; byStatus: Record<string, number> };
  malformed: { total: number; byStatus: Record<string, number> };
  retirement: RetirementAssessment[];
}

interface Row { format: string; label: string | null; status: string; count: number }

/** Aggregate envelope shapes per queue state. Only counts, formats, statuses
 *  and well-formed key labels leave the database. */
async function readEnvelopeCounts(): Promise<{ rows: Row[]; withoutCredentials: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const result = await tx.execute(sql`
      WITH envelopes AS (
        SELECT status,
               string_to_array(encrypted_token_payload, '.') AS parts
        FROM contractor_email_queue
        WHERE encrypted_token_payload IS NOT NULL
      )
      , shaped AS (
        SELECT status, parts,
          cardinality(parts) = 5 AND parts[1] IN ('v1', 'v2')
            AND parts[2] ~ '^[A-Za-z0-9_-]{1,32}$'
            AND parts[3] ~ '^[A-Za-z0-9_-]+$' AND parts[4] ~ '^[A-Za-z0-9_-]+$' AND parts[5] ~ '^[A-Za-z0-9_-]+$' AS versioned,
          cardinality(parts) = 3
            AND parts[1] ~ '^[A-Za-z0-9_-]+$' AND parts[2] ~ '^[A-Za-z0-9_-]+$' AND parts[3] ~ '^[A-Za-z0-9_-]+$' AS legacy
        FROM envelopes
      )
      SELECT
        CASE WHEN versioned THEN parts[1] WHEN legacy THEN 'legacy' ELSE 'malformed' END AS format,
        CASE WHEN versioned THEN parts[2] ELSE NULL END AS label,
        status,
        count(*)::int AS count
      FROM shaped
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `);
    const empty = await tx.execute(sql`
      SELECT count(*)::int AS count FROM contractor_email_queue WHERE encrypted_token_payload IS NULL
    `);
    return {
      rows: (result.rows as unknown as Row[]).map((row) => ({ ...row, count: Number(row.count) })),
      withoutCredentials: Number((empty.rows as { count: number }[])[0]?.count ?? 0),
    };
  });
}

const isActive = (status: string) => (ACTIVE_QUEUE_STATES as readonly string[]).includes(status);

export function buildKeyPreflightReport(input: {
  rows: Row[];
  withoutCredentials: number;
  configuration: TokenKeyConfiguration;
  writersDrainedConfirmed: boolean;
  now?: Date;
}): KeyPreflightReport {
  const { configuration } = input;
  const envelopes: EnvelopeCount[] = input.rows.map((row) => {
    const format = (["v2", "v1", "legacy"].includes(row.format) ? row.format : "malformed") as EnvelopeFormat;
    // A versioned envelope whose label is not a valid key name is malformed.
    const versioned = format === "v2" || format === "v1";
    const labelOk = versioned && row.label !== null && KEY_LABEL.test(row.label);
    return {
      format: versioned && !labelOk ? "malformed" : format,
      keyVersion: labelOk ? row.label : null,
      status: row.status,
      count: row.count,
    };
  });

  const usage = new Map<string, VersionUsage>();
  const legacy = { total: 0, active: 0, byStatus: {} as Record<string, number> };
  const malformed = { total: 0, byStatus: {} as Record<string, number> };
  for (const envelope of envelopes) {
    if (envelope.keyVersion) {
      const entry = usage.get(envelope.keyVersion) ?? {
        keyVersion: envelope.keyVersion,
        configured: envelope.keyVersion === configuration.currentVersion ? "current"
          : configuration.retainedVersions.includes(envelope.keyVersion) ? "retained"
          : envelope.keyVersion === "session-v1" ? "session"
          : "missing",
        active: 0,
        historical: 0,
        byStatus: {},
      };
      if (isActive(envelope.status)) entry.active += envelope.count;
      else entry.historical += envelope.count;
      entry.byStatus[envelope.status] = (entry.byStatus[envelope.status] ?? 0) + envelope.count;
      usage.set(envelope.keyVersion, entry);
    } else if (envelope.format === "legacy") {
      legacy.total += envelope.count;
      if (isActive(envelope.status)) legacy.active += envelope.count;
      legacy.byStatus[envelope.status] = (legacy.byStatus[envelope.status] ?? 0) + envelope.count;
    } else {
      malformed.total += envelope.count;
      malformed.byStatus[envelope.status] = (malformed.byStatus[envelope.status] ?? 0) + envelope.count;
    }
  }

  const retirement: RetirementAssessment[] = configuration.retainedVersions.map((version) => {
    const blockers: string[] = [];
    const used = usage.get(version);
    if (configuration.problems.length > 0) blockers.push("The key configuration has problems; fix them first.");
    if (used && used.active > 0) blockers.push(`${used.active} pending, approved or sending draft(s) still use this key.`);
    if (used && used.historical > 0) {
      blockers.push(`${used.historical} historical draft(s) still use this key; restart the current version so startup re-encryption moves them, or investigate drafts it skipped.`);
    }
    if (legacy.total > 0) {
      blockers.push(`${legacy.total} legacy unversioned draft(s) remain and may need any configured key.`);
    }
    if (!input.writersDrainedConfirmed) {
      blockers.push("Old writers not confirmed drained: stop every instance still configured with this key as current, then re-run with --writers-drained.");
    }
    return { keyVersion: version, safeToRetire: blockers.length === 0, blockers };
  });

  const withCredentials = envelopes.reduce((sum, envelope) => sum + envelope.count, 0);
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    configuration,
    writersDrainedConfirmed: input.writersDrainedConfirmed,
    totals: { drafts: withCredentials + input.withoutCredentials, withCredentials, withoutCredentials: input.withoutCredentials },
    envelopes,
    versions: [...usage.values()].sort((a, b) => a.keyVersion.localeCompare(b.keyVersion)),
    legacyUnversioned: legacy,
    malformed,
    retirement,
  };
}

export async function runKeyPreflight(options: { writersDrainedConfirmed: boolean }): Promise<KeyPreflightReport> {
  const { rows, withoutCredentials } = await readEnvelopeCounts();
  return buildKeyPreflightReport({
    rows,
    withoutCredentials,
    configuration: describeTokenKeyConfiguration(),
    writersDrainedConfirmed: options.writersDrainedConfirmed,
  });
}

/** Plain-text summary for operators. */
export function formatKeyPreflightReport(report: KeyPreflightReport): string {
  const lines: string[] = [];
  const config = report.configuration;
  lines.push(`Contractor token key preflight — ${report.generatedAt} (read-only)`);
  lines.push(`Current key: ${config.currentVersion ?? "NOT CONFIGURED"} (${config.currentSource ?? "none"})`);
  lines.push(`Retained keys: ${config.retainedVersions.length ? config.retainedVersions.join(", ") : "none"}`);
  for (const problem of config.problems) lines.push(`  ! ${problem}`);
  lines.push("");
  lines.push(`Drafts: ${report.totals.drafts} (${report.totals.withCredentials} with encrypted links, ${report.totals.withoutCredentials} without)`);
  for (const version of report.versions) {
    const states = Object.entries(version.byStatus).map(([status, count]) => `${status}=${count}`).join(", ");
    lines.push(`  ${version.keyVersion} [${version.configured}]: ${version.active} active, ${version.historical} historical (${states})`);
  }
  if (report.legacyUnversioned.total) lines.push(`  legacy unversioned: ${report.legacyUnversioned.total} (${report.legacyUnversioned.active} active)`);
  if (report.malformed.total) lines.push(`  malformed envelopes: ${report.malformed.total}`);
  lines.push("");
  if (report.retirement.length === 0) lines.push("No retained keys to retire.");
  for (const assessment of report.retirement) {
    lines.push(`Retire ${assessment.keyVersion}: ${assessment.safeToRetire ? "SAFE" : "NOT YET"}`);
    for (const blocker of assessment.blockers) lines.push(`  - ${blocker}`);
  }
  return lines.join("\n");
}
