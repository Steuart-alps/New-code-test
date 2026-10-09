import { build } from "esbuild";
if (!process.argv[2]) throw new Error("Output directory required");
await build({
  entryPoints: ["tests/fresh-schema-server.ts"],
  outfile: `${process.argv[2]}/server.mjs`,
  bundle: true, platform: "node", format: "esm",
  external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
  banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
});