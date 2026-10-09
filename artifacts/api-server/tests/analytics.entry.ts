// Bundled by tests/analytics.mjs: the real app (full middleware chain) plus
// the analytics helpers, run in-process against the harness's disposable DB.
export { default as app } from "../src/app";
export { pool } from "@workspace/db";
export { purgeExpiredAnalyticsEvents, ANALYTICS_EVENT_REGISTRY } from "../src/lib/analytics";
