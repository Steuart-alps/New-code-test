#!/usr/bin/env node
// Checks openapi.yaml against the agreed contract baseline
// (openapi.baseline.yaml, the contract deployed clients were built against).
//
//   node scripts/check-contract.mjs            CI: fail on breaking changes, or when
//                                              compatible changes are not yet recorded
//   node scripts/check-contract.mjs --record   codegen: record compatible changes in the
//                                              baseline; leave it alone if anything breaks
//   node scripts/check-contract.mjs --accept   record the current contract even though
//                                              it breaks old clients (a deliberate decision)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { compareContracts, formatFinding } from "./contract-diff.mjs";

const specDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const currentPath = path.join(specDir, "openapi.yaml");
const baselinePath = path.join(specDir, "openapi.baseline.yaml");
const mode = process.argv.includes("--accept") ? "accept" : process.argv.includes("--record") ? "record" : "check";

const [currentText, baselineText] = await Promise.all([
  readFile(currentPath, "utf8"),
  readFile(baselinePath, "utf8"),
]);
const { breaking, warnings } = compareContracts(parse(baselineText), parse(currentText));

const list = (findings, mark) => findings.map((f) => `  ${mark} ${formatFinding(f)}`).join("\n");
if (warnings.length > 0) {
  console.warn(`API contract: ${warnings.length} change(s) old clients may not expect:\n${list(warnings, "!")}`);
}

const record = async (message) => {
  if (currentText !== baselineText) {
    await writeFile(baselinePath, currentText);
    console.log(message);
  }
};

if (mode === "accept") {
  if (breaking.length > 0) {
    console.warn(`Accepting ${breaking.length} breaking change(s):\n${list(breaking, "✗")}`);
  }
  await record("API contract baseline updated to the current openapi.yaml.");
} else if (breaking.length > 0) {
  const message =
    `API contract: ${breaking.length} breaking change(s) against lib/api-spec/openapi.baseline.yaml:\n` +
    `${list(breaking, "✗")}\n` +
    "Clients already deployed (including installed phone apps) would break. Make the change additive\n" +
    "instead (new optional field, new endpoint), or, if breaking them is intended, run\n" +
    "`pnpm run api-contract:accept` and commit the baseline.";
  if (mode === "record") {
    console.warn(`${message}\nThe baseline was not updated.`);
  } else {
    console.error(message);
    process.exitCode = 1;
  }
} else if (mode === "record") {
  await record("API contract baseline updated with compatible changes.");
} else if (currentText !== baselineText) {
  console.error(
    "API contract: openapi.yaml has compatible changes that are not recorded in openapi.baseline.yaml.\n" +
      "Run `pnpm --dir lib/api-spec run codegen` (it records them) and commit the baseline.",
  );
  process.exitCode = 1;
} else {
  console.log("API contract matches the baseline; no breaking changes.");
}
