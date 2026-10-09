// Real API/middleware, without billing network initialization or scheduled jobs.
import app, { markApplicationReady } from "../src/app";
import { runRuntimeMigrations } from "../src/lib/runtimeMigrations";
import { pool } from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { verifyLegacyPatHistoryMigration } from "./pat-legacy-history-migration";
import { verifyPatRoomHistoryMigration } from "./pat-room-history-migration";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1") {
  throw new Error("This entry point is only for isolated schema tests");
}
// Only the external object store is replaced. Real route validation, ACL logic,
// SQL writes and reads still execute. This is not an upload integration test.
ObjectStorageService.prototype.getObjectEntityFile = async function (path) {
  if (!/^\/objects\/uploads\/tenant-\d+\/schema-fixture\.pdf$/.test(path)) {
    throw new Error("Unexpected object path in schema test");
  }
  return {
    name: path,
    exists: async () => [true],
    getMetadata: async () => [{ metadata: {} }],
    setMetadata: async () => [],
  } as any;
};
await runRuntimeMigrations();
await verifyLegacyPatHistoryMigration();
await verifyPatRoomHistoryMigration();
await runRuntimeMigrations(); // Boot migrations must also be idempotent.
markApplicationReady();
const server = app.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => { void pool.end().then(() => process.exit(0)); }));