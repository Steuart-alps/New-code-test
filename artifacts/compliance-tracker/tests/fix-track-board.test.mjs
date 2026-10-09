// Runs src/pages/tests/fix-track.test.tsx (FixTrack board ordering and
// days-past-target) under the UK time zone so the DST cases are real.
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
// Inside the package so the bundle resolves its react/react-dom dependencies.
const tempDir = await mkdtemp(path.join(root, "tests", ".fix-track-board-"));
const outfile = path.join(tempDir, "fix-track.test.mjs");
try {
  await build({
    entryPoints: [path.join(root, "src/pages/tests/fix-track.test.tsx")],
    outfile, bundle: true, format: "esm", platform: "node", jsx: "automatic",
    tsconfig: path.join(root, "tsconfig.json"), logLevel: "silent",
    external: ["react", "react-dom", "react/jsx-runtime"],
    banner: { js: "import { createRequire as __r } from \"node:module\"; const require = __r(import.meta.url);" },
  });
  const run = spawnSync(process.execPath, [outfile], {
    env: { ...process.env, TZ: "Europe/London" }, stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
