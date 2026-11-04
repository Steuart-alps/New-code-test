// Real API and middleware for the public sign-off suite (sign-off-access.mjs),
// without billing network initialization or scheduled jobs. Only the external
// object store is replaced: private objects under
// /objects/uploads/tenant-<id>/sign-off-*.pdf exist and are owned by <id>, so
// download routes run their real document lookup, ACL check and token issue.
import app, { markApplicationReady } from "../src/app";
import { runRuntimeMigrations } from "../src/lib/runtimeMigrations";
import { pool } from "@workspace/db";
import { ObjectStorageService, ObjectNotFoundError } from "../src/lib/objectStorage";

if (process.env.NODE_ENV !== "test" || process.env.SIGN_OFF_ACCESS_TEST !== "1") {
  throw new Error("This entry point is only for the sign-off access tests");
}

ObjectStorageService.prototype.getObjectEntityFile = async function (path) {
  const owner = /^\/objects\/uploads\/tenant-(\d+)\/sign-off-[a-z0-9-]+\.pdf$/.exec(path)?.[1];
  if (!owner) throw new ObjectNotFoundError();
  const aclPolicy = JSON.stringify({ owner, visibility: "private" });
  return {
    name: path,
    exists: async () => [true],
    getMetadata: async () => [{ metadata: { "custom:aclPolicy": aclPolicy } }],
    setMetadata: async () => [],
  } as any;
};

await runRuntimeMigrations();
markApplicationReady();
const server = app.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => { void pool.end().then(() => process.exit(0)); }));
