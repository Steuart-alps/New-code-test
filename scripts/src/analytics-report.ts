// Read-only first-party analytics report straight from DATABASE_URL: the same
// aggregates as GET /api/internal/analytics/summary.
//
//   pnpm --filter @workspace/scripts run analytics:report -- \
//     --from 2026-10-01 --to 2026-10-31 [--event NAME] [--group-by DIMENSION] [--json]
//
// It only runs SELECTs; it never writes. Days are UTC calendar days.
import { parseArgs } from "node:util";
import {
  formatAnalyticsSummary,
  queryAnalyticsSummary,
  validateAnalyticsSummaryQuery,
} from "@workspace/db/analytics";

const usage = "Usage: analytics:report -- --from YYYY-MM-DD --to YYYY-MM-DD [--event NAME] [--group-by DIMENSION] [--json]";

let values: { from?: string; to?: string; event?: string; "group-by"?: string; json?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({
    // pnpm may forward the "--" separator itself; it carries no option.
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      event: { type: "string" },
      "group-by": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  }));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(usage);
  process.exit(2);
}

if (values.help) {
  console.log(usage);
  process.exit(0);
}

const parsed = validateAnalyticsSummaryQuery({
  from: values.from,
  to: values.to,
  event: values.event,
  groupBy: values["group-by"],
});
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(usage);
  process.exit(2);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(2);
}

// Imported only after validation: @workspace/db opens a pool from DATABASE_URL.
const { pool } = await import("@workspace/db");
try {
  const summary = await queryAnalyticsSummary(pool, parsed.query);
  console.log(values.json ? JSON.stringify(summary, null, 2) : formatAnalyticsSummary(summary));
} finally {
  await pool.end();
}
