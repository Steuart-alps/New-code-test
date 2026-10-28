// Route-to-contract inventory: every /api route the server mounts must be in
// lib/api-spec/openapi.yaml (so the generated client and zod schemas cover
// it), or be listed below as intentionally excluded, or be on the
// not-yet-documented backlog (openapi-route-backlog.json), which may only
// shrink. The check fails when:
//   - a route is in none of those (a new route missing from the contract);
//   - an operation in openapi.yaml is not served (wrong method or path);
//   - a contract operation's path parameter names differ from the route's;
//   - two routes declare the same method and path (the later one never runs);
//   - an exclusion or backlog entry no longer matches a route, or a backlog
//     route is now in the contract (remove the entry);
//   - a route path cannot be read statically.
// Routes are found by tests/lib/express-routes.mjs, which follows the mounts
// from src/app.ts; no server or database is needed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { discoverRoutes } from "./lib/express-routes.mjs";

const excluded = (reason) => ({ reason });
// A link token in the URL is the only credential; the web page for the link
// calls these with fetch, and they are not part of the signed-in API.
const tokenLink = excluded("public link authorised only by the token in the URL");
const fileStream = excluded("streams a stored file by a wildcard object path, not JSON");

const EXCLUDED = {
  "POST /api/stripe/webhook": excluded("Stripe webhook; Stripe signs and sends it"),
  "POST /api/inbound/certificate-email": excluded("Resend inbound email webhook; Resend signs and sends it"),
  "GET /api/internal/analytics/summary": excluded("operator report behind ANALYTICS_READ_TOKEN, not called by apps"),
  "POST /api/admin/seed-demo": excluded("one-off demo price seed behind DEMO_SEED_TOKEN"),
  "GET /api/storage/download/:token": excluded("signed download link opened by the browser"),
  "GET /api/storage/public-objects/*filePath": fileStream,
  "GET /api/storage/objects/*path": fileStream,
  "GET /api/contractor-portal/:token": tokenLink,
  "PUT /api/contractor-portal/:token": tokenLink,
  "POST /api/contractor-portal/:token/upload-url": tokenLink,
  "POST /api/contractor-portal/:token/certificates": tokenLink,
  "GET /api/contractor-portal/:token/certificates/:certId/download": tokenLink,
  "DELETE /api/contractor-portal/:token/certificates/:certId": tokenLink,
  "GET /api/fix-track/action/:token": tokenLink,
  "POST /api/fix-track/action/:token": tokenLink,
  "POST /api/fix-track/action/:token/booked": tokenLink,
  "POST /api/fix-track/action/:token/upload-url": tokenLink,
  "GET /api/fix-track/quotes/public/:token": tokenLink,
  "POST /api/fix-track/quotes/public/:token": tokenLink,
  "GET /api/notifications/public/schedule/:token": tokenLink,
  "POST /api/notifications/public/schedule/:token": tokenLink,
  "GET /api/certificate-upload/:token": tokenLink,
  "POST /api/certificate-upload/:token": tokenLink,
  "GET /api/sign-off/:token/info": tokenLink,
  "GET /api/sign-off/:token/departments": tokenLink,
  "GET /api/sign-off/:token/staff": tokenLink,
  "GET /api/sign-off/:token/documents": tokenLink,
  "GET /api/sign-off/:token/documents/:docId/download": tokenLink,
  "POST /api/sign-off/:token/acknowledge": tokenLink,
  "GET /api/site-sign-in/:token": tokenLink,
  "POST /api/site-sign-in/:token/sign-in": tokenLink,
  "POST /api/site-sign-in/:token/visit": tokenLink,
  "POST /api/site-sign-in/:token/sign-out": tokenLink,
};

// Same method and path declared in two files. Express runs the first; the
// second never handles a request. Each entry names the file that wins.
const KNOWN_DUPLICATES = {
  // The contract (listCertificates etc.) describes certificates.ts, but
  // contractors.ts is mounted first and serves the contractor_certificates
  // table with a different body, so the contract does not match what runs.
  "GET /contractors/{}/certificates": "routes/contractors.ts",
  "POST /contractors/{}/certificates": "routes/contractors.ts",
  "PUT /contractors/{}/certificates/{}": "routes/contractors.ts",
  "DELETE /contractors/{}/certificates/{}": "routes/contractors.ts",
};

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const spec = parse(readFileSync(here("../../../lib/api-spec/openapi.yaml"), "utf8"));
const backlog = JSON.parse(readFileSync(here("./openapi-route-backlog.json"), "utf8"));
const { routes: allRoutes, problems } = discoverRoutes(here("../src/app.ts"));

const apiBase = (spec.servers?.[0]?.url ?? "/api").replace(/\/$/, "");
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const shape = (path) => path.replace(/\{[^}]+\}/g, "{}");
const routeKey = (route) => `${route.method} ${route.fullPath}`;
const where = (route) => `${route.file}:${route.line}`;

const routes = allRoutes.filter((route) => route.fullPath === apiBase || route.fullPath.startsWith(`${apiBase}/`));

// Express path -> OpenAPI path, or null when it uses syntax OpenAPI cannot express.
function toContractPath(fullPath) {
  const local = fullPath.slice(apiBase.length) || "/";
  if (/[*?{}()]/.test(local)) return null;
  return local.replace(/:(\w+)/g, "{$1}");
}

const served = new Map(); // "METHOD /shape" -> routes
for (const route of routes) {
  const contractPath = toContractPath(route.fullPath);
  route.contractPath = contractPath;
  if (!contractPath) continue;
  const key = `${route.method} ${shape(contractPath)}`;
  served.set(key, [...(served.get(key) ?? []), route]);
}

const documented = new Map(); // "METHOD /shape" -> { path, operationId }
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const method of METHODS) {
    if (item[method]) documented.set(`${method.toUpperCase()} ${shape(path)}`, { path, operationId: item[method].operationId });
  }
}

const backlogKeys = new Set(Object.values(backlog).flat());
const routeKeys = new Set(routes.map(routeKey));

for (const [key, matches] of served) {
  if (matches.length < 2) continue;
  const winner = KNOWN_DUPLICATES[key];
  if (winner && matches[0].file === winner) continue;
  problems.push(`${key} is declared ${matches.length} times (${matches.map(where).join(", ")}); `
    + `only the first runs. Remove or rename the others.`);
}
for (const key of Object.keys(KNOWN_DUPLICATES)) {
  if ((served.get(key) ?? []).length < 2) problems.push(`KNOWN_DUPLICATES "${key}" is no longer duplicated (remove the entry)`);
}

for (const [key, { path, operationId }] of documented) {
  const label = `${key.split(" ")[0]} ${path} (${operationId ?? "no operationId"})`;
  const matches = served.get(key);
  if (!matches) {
    const otherMethods = routes
      .filter((route) => route.contractPath && shape(route.contractPath) === shape(path))
      .map((route) => `${route.method} at ${where(route)}`);
    problems.push(`${label} is in openapi.yaml but the server has no such route`
      + (otherMethods.length ? `; the path is served as ${otherMethods.join(", ")}` : "; check the method and path"));
    continue;
  }
  const route = matches[0];
  const specNames = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const routeNames = [...route.fullPath.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (specNames.join() !== routeNames.join() && !KNOWN_DUPLICATES[key]) {
    problems.push(`${label}: path parameters {${specNames.join("}, {")}} in openapi.yaml but `
      + `:${routeNames.join(", :")} at ${where(route)}`);
  }
}

let missing = 0;
for (const route of routes) {
  const key = routeKey(route);
  const inContract = route.contractPath && documented.has(`${route.method} ${shape(route.contractPath)}`);
  if (inContract) {
    if (backlogKeys.has(key)) problems.push(`${key} is now in openapi.yaml; remove it from openapi-route-backlog.json`);
    if (EXCLUDED[key]) problems.push(`${key} is in openapi.yaml but also listed in EXCLUDED; remove the exclusion`);
    continue;
  }
  if (EXCLUDED[key] || backlogKeys.has(key)) continue;
  missing += 1;
  problems.push(`${key} (${where(route)}) is not in lib/api-spec/openapi.yaml. Add the operation and run `
    + `\`pnpm --dir lib/api-spec run codegen\`, or, if apps must not call it through the generated client, `
    + `list it in EXCLUDED in tests/openapi-route-inventory.mjs with the reason.`);
}
for (const key of Object.keys(EXCLUDED)) {
  if (!routeKeys.has(key)) problems.push(`EXCLUDED "${key}" matches no route (remove it)`);
}
for (const [file, keys] of Object.entries(backlog)) {
  for (const key of keys) {
    if (!routeKeys.has(key)) problems.push(`openapi-route-backlog.json "${key}" (${file}) matches no route (remove it)`);
  }
}

const inContract = routes.filter((route) => route.contractPath && documented.has(`${route.method} ${shape(route.contractPath)}`)).length;
console.log(`API routes: ${routes.length} (in openapi.yaml ${inContract}, excluded ${Object.keys(EXCLUDED).length}, `
  + `not yet documented ${backlogKeys.size}, new and undocumented ${missing}).`);
if (problems.length) {
  console.error("\nRoute-to-contract inventory problems:");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log("Every API route is in the contract, intentionally excluded, or on the documentation backlog.");
