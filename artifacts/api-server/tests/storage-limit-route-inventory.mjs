// Every route that hands out an upload link for a business must check the
// business's paid storage first (lib/storageLimit.ts), so uploads stop at the
// limit everywhere, not just on the main upload route. Static check: each
// getObjectEntityUploadURL call in src/routes is preceded, in the same
// handler, by ensureUploadCapacity for the same tenant. Routes that upload
// for something other than a business are listed with the reason.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");
const EXEMPT = {
  "consultant-portfolio.ts": "consultant branding logos belong to the consultant, not a business's storage",
};

const failures = [];
let gated = 0;
for (const file of (await readdir(routesDir)).filter((name) => name.endsWith(".ts")).sort()) {
  const lines = (await readFile(path.join(routesDir, file), "utf8")).split("\n");
  lines.forEach((line, index) => {
    const call = line.match(/getObjectEntityUploadURL\(\s*([^,)]+)/);
    if (!call) return;
    if (EXEMPT[file]) return;
    const tenant = call[1].trim();
    // Look back to the start of the handler for the gate on the same tenant.
    let gate = false;
    for (let i = index - 1; i >= 0 && !/^router\.|^\}\);/.test(lines[i]); i--) {
      if (lines[i].includes(`ensureUploadCapacity(${tenant},`)) { gate = true; break; }
    }
    if (gate) gated++;
    else failures.push(`${file}:${index + 1} issues an upload link for ${tenant} without ensureUploadCapacity(${tenant}, ...)`);
  });
}

console.log(`Storage limit: ${gated} upload-link routes check paid storage; exempt: ${Object.entries(EXEMPT).map(([f, why]) => `${f} (${why})`).join(", ")}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
