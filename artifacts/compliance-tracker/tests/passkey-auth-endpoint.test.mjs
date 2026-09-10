import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const login = await readFile(new URL("../src/pages/login.tsx", import.meta.url), "utf8");
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

assert.match(
  login,
  /apiFetch\("\/auth\/passkeys\/authenticate",/,
  "passkey authentication must use the shared API fetch helper",
);
assert.doesNotMatch(
  login,
  /fetch\(`\$\{baseUrl\}\/auth\/passkeys\/authenticate`/,
  "passkey authentication must not target the artifact base path directly",
);
assert.match(
  api,
  /const API_BASE = `\$\{BASE\}\/api`/,
  "shared API fetch must include the API prefix after the artifact base path",
);
assert.match(
  api,
  /fetch\(`\$\{API_BASE\}\$\{path\}`/,
  "shared API fetch must preserve the artifact base path when constructing requests",
);

console.log("Passkey authentication endpoint regression tests passed.");