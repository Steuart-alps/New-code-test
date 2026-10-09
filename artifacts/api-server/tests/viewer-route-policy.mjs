// Structural guardrail for authenticated mutation routes.
//
// Business mutations must explicitly block client_viewer accounts with
// denyViewers, or use a consultant/client-admin role guard. The exceptions
// below are intentionally token-bound or self-service flows whose authorization
// is implemented by a capability/token check rather than a user role.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const routesDirectory = fileURLToPath(new URL("../src/routes", import.meta.url));
const routeFiles = execFileSync(
  "find",
  [routesDirectory, "-maxdepth", "1", "-name", "*.ts", "-print"],
  { encoding: "utf8" },
).trim().split("\n").filter(Boolean);

function routeException(file, method, path) {
  const name = basename(file);
  if (name === "auth.ts") return "auth/session self-service";
  if (name === "fix-track-public.ts" || name === "contractor-portal.ts" || name === "sign-off.ts") {
    return "public token portal";
  }
  // notificationsPublicRouter, mounted at /notifications/public/schedule.
  if (name === "notifications.ts" && method === "POST" && path === "/:token") {
    return "public scheduling token";
  }
  if (name === "feedback.ts" && method === "POST" && path === "/feedback") {
    return "feedback submission";
  }
  if (name === "analytics.ts" && method === "POST" && path === "/analytics/events") {
    return "first-party analytics event (no tenant data)";
  }
  if (name === "mobile.ts" && ["POST", "DELETE"].includes(method) && path === "/mobile/push-token") {
    return "mobile push-token registration";
  }
  if (name === "safe-track.ts" && method === "POST" && path.endsWith("/self-acknowledge")) {
    return "SafeTrack self-acknowledgement";
  }
  if (name === "staff-roster.ts" && (
    path === "/staff/:id/set-pin" ||
    path === "/staff/verify-pin" ||
    path === "/staff/kiosk-action"
  )) {
    return "staff kiosk/enrollment capability";
  }
  if (name === "admin.ts" && method === "POST" && path === "/admin/seed-demo") {
    return "secret-token demo seed endpoint";
  }
  return null;
}

const routes = [];
for (const file of routeFiles) {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["router", "sub", "notificationsPublicRouter"].includes(node.expression.expression.getText(sourceFile)) &&
      ["post", "put", "patch", "delete"].includes(node.expression.name.text)
    ) {
      const [pathArg, ...rest] = node.arguments;
      const path = pathArg?.getText(sourceFile).replace(/^["'`]|["'`]$/g, "") ?? "";
      const middleware = rest.slice(0, -1).map((arg) => arg.getText(sourceFile)).join(" ").replace(/\s+/g, " ");
      routes.push({
        file,
        method: node.expression.name.text.toUpperCase(),
        path,
        middleware,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

const unguarded = routes.filter((route) => {
  if (/\bdenyViewers\b|\brequire(?:ClientAdmin|Consultant|Role)\b/.test(route.middleware)) return false;
  return !routeException(route.file, route.method, route.path);
});

console.log(`Checked ${routes.length} POST/PUT/PATCH/DELETE route declarations.`);
console.log(`Documented exceptions: ${routes.filter((route) => routeException(route.file, route.method, route.path)).length}.`);
if (unguarded.length) {
  console.error("\nMutation routes without an explicit viewer policy:");
  for (const route of unguarded) {
    console.error(` - ${route.file}:${route.method} ${route.path} (${route.middleware || "no middleware"})`);
  }
  process.exit(1);
}
console.log("All business mutations declare denyViewers or an admin/consultant role guard.");