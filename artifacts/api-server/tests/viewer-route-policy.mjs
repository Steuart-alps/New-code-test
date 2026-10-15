// Structural guardrail for authenticated mutation routes.
//
// Business mutations must explicitly block client_viewer accounts with
// denyViewers, or use a consultant/client-admin role guard. EXCEPTIONS lists,
// route by route, the token-bound and self-service flows that are authorized
// by something other than a user role. Each entry names its mechanism and the
// source evidence (`proof`) of that check, taken from the route's middleware
// or handler. The check fails when:
//   - a mutation route has no viewer guard and no exception;
//   - an exception's route no longer exists (or two routes share its key);
//   - an exception's route now has a viewer guard (remove the exception);
//   - an exception's proof no longer matches, so its token or account check
//     was removed or renamed and the route needs a fresh review.
// Keys are "<file> <METHOD> <path>", with " [<router>]" when the route is not
// declared on `router`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const exception = (mechanism) => (reason, ...proof) => ({ mechanism, reason, proof });
// No session yet: the caller proves who they are, rate-limited per IP/account.
const signIn = exception("sign-in or account recovery, rate-limited");
// The signed-in user changes only their own login, session or device.
const ownAccount = exception("signed-in user's own account");
// An unguessable link token, looked up by its digest, scopes the write.
const linkToken = exception("public link token");
// A kiosk enrollment token or capability scopes the write to one staff action.
const kioskToken = exception("kiosk token or capability");
// The signed-in user's own action, writing no business record a viewer could not.
const ownAction = exception("signed-in user's own action");
// A server secret in the Authorization header.
const secretToken = exception("server secret token");

const EXCEPTIONS = {
  "auth.ts POST /auth/login": signIn("password sign-in", /\bloginRateLimit\b/),
  "auth.ts POST /auth/passkeys/authenticate": signIn("passkey sign-in", /\bloginRateLimit\b/),
  "auth.ts POST /auth/2fa/verify": signIn("second factor at sign-in", /\bloginRateLimit\b/, /\blimitTotpGuessesPerAccount\b/),
  "auth.ts POST /auth/2fa/recover": signIn("recovery-code sign-in", /\bloginRateLimit\b/),
  "auth.ts POST /auth/mobile-login": signIn("mobile sign-in", /\bloginRateLimit\b/),
  "auth.ts POST /auth/mobile-login/verify-totp": signIn("mobile second factor", /\bloginRateLimit\b/, /\bresolveMobileChallengeAccount\b/, /\blimitTotpGuessesPerAccount\b/),
  "auth.ts POST /auth/forgot-password": signIn("password reset email", /\bforgotPasswordRateLimit\b/, /\bforgotPasswordEmailRateLimit\b/),
  "auth.ts POST /auth/reset-password": signIn("password reset with emailed token", /\bresetPasswordRateLimit\b/),
  "auth.ts POST /auth/register": signIn("new business sign-up", /\bregistrationRateLimit\b/),
  "auth.ts POST /auth/resend-verification": signIn("verification email", /\bregistrationRateLimit\b/),
  "auth.ts POST /auth/passkeys/registration/options": ownAccount("start passkey setup", /\bgetPasskeySetupUserId\(req\)/),
  "auth.ts POST /auth/passkeys/registration/verify": ownAccount("finish passkey setup", /\bpendingPasskeyRegistrationUserId\b/, /\bpendingPasskeyRegistrationChallenge\b/),
  "auth.ts DELETE /auth/passkeys/:id": ownAccount("remove own passkey", /\brequireAuth\b/, /passkeysTable\.userId,\s*req\.currentUser!\.id/),
  "auth.ts POST /auth/2fa/enable": ownAccount("finish two-factor setup", /\bgetTwoFactorSetupUserId\(req\)/),
  "auth.ts POST /auth/2fa/recovery-codes/regenerate": ownAccount("own recovery codes", /\brequireAuth\b/, /usersTable\.id,\s*req\.currentUser!\.id/, /\bverifyPassword\(/),
  "auth.ts POST /auth/2fa/disable": ownAccount("own two-factor", /\brequireAuth\b/, /usersTable\.id,\s*req\.currentUser!\.id/, /\bisTwoFactorRequired\(/),
  "auth.ts POST /auth/logout": ownAccount("end own session", /\breq\.session\.destroy\(/),
  "auth.ts POST /auth/mobile-refresh": ownAccount("refresh own mobile session", /\brequireAuth\b/, /FROM mobile_sessions\s+WHERE token IN/),
  "auth.ts POST /auth/mobile-logout": ownAccount("end own mobile session", /\brequireAuth\b/, /DELETE FROM mobile_sessions WHERE token IN/),
  "mobile.ts POST /mobile/push-token": ownAccount("register own device", /\brequireAuth\b/, /\buserId = req\.currentUser!\.id/),
  "mobile.ts DELETE /mobile/push-token": ownAccount("unregister own device", /\brequireAuth\b/, /AND user_id = \$\{userId\}/),
  "contractor-portal.ts PUT /:token": linkToken("contractor updates their job", /\bvalidateToken\(req\.params\.token\b/),
  "contractor-portal.ts POST /:token/upload-url": linkToken("contractor upload", /\bvalidateToken\(req\.params\.token\b/),
  "contractor-portal.ts POST /:token/certificates": linkToken("contractor certificate", /\bvalidateToken\(req\.params\.token\b/),
  "contractor-portal.ts DELETE /:token/certificates/:certId": linkToken("contractor removes own certificate", /\bvalidateToken\(req\.params\.token\b/),
  "fix-track-public.ts POST /:token [fixTrackQuoteRouter]": linkToken("contractor quote", /quote_token_hash=\$\{digestBearerToken\(req\.params\.token\)\}/),
  "fix-track-public.ts POST /:token": linkToken("contractor job response", /\blookupToken\(req\.params\.token\)/),
  "fix-track-public.ts POST /:token/booked": linkToken("contractor booking", /\blookupToken\(req\.params\.token\)/),
  "fix-track-public.ts POST /:token/upload-url": linkToken("contractor upload", /\blookupToken\(req\.params\.token\)/),
  "sign-off.ts POST /:token/acknowledge": linkToken("staff document sign-off", /\bresolveClient\(req\.params\.token\b/),
  "notifications.ts POST /:token [notificationsPublicRouter]": linkToken("contractor visit scheduling", /\bscheduleTokenDigest\(req\.params\.token\)/),
  "staff-roster.ts POST /staff/:id/set-pin": kioskToken("PIN enrollment", /\benrollmentRateLimit\b/, /\breq\.body\?\.enrollment_token\b/, /\bdigestBearerToken\(parsedToken\.data\)/),
  "staff-roster.ts POST /staff/verify-pin": kioskToken("kiosk PIN check", /\bkioskClient\(req\.header\("x-kiosk-token"\)\)/),
  "staff-roster.ts POST /staff/kiosk-action": kioskToken("one kiosk action", /token_hash=\$\{digestBearerToken\(parsed\.data\.capability\)\}/),
  "safe-track.ts POST /risk-assessments/:id/self-acknowledge": ownAction("acknowledge a document for oneself", /\brequireAuth\b/, /\bselfAckRoute\(/),
  "safe-track.ts POST /sops/:id/self-acknowledge": ownAction("acknowledge a document for oneself", /\brequireAuth\b/, /\bselfAckRoute\(/),
  "safe-track.ts POST /handbook/:id/self-acknowledge": ownAction("acknowledge a document for oneself", /\brequireAuth\b/, /\bselfAckRoute\(/),
  "feedback.ts POST /feedback": ownAction("send product feedback", /\brequireAuth\b/),
  "analytics.ts POST /analytics/events": ownAction("first-party analytics event (no tenant data)", /\brequireCookieSession\b/, /\bvalidateAnalyticsEvent\(/),
  "admin.ts POST /admin/seed-demo": secretToken("demo price seed", /\bprocess\.env\.DEMO_SEED_TOKEN\b/, /\bpresented !== token\b/),
};

const VIEWER_GUARD = /\bdenyViewers\b|\brequire(?:ClientAdmin|Consultant|Role)\b/;
const routesDirectory = fileURLToPath(new URL("../src/routes", import.meta.url));
const routeFiles = execFileSync(
  "find",
  [routesDirectory, "-maxdepth", "1", "-name", "*.ts", "-print"],
  { encoding: "utf8" },
).trim().split("\n").filter(Boolean).sort();

const routes = [];
for (const file of routeFiles) {
  const name = basename(file);
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(?:router|sub|\w+Router)$/.test(node.expression.expression.getText(sourceFile)) &&
      ["post", "put", "patch", "delete"].includes(node.expression.name.text)
    ) {
      const receiver = node.expression.expression.getText(sourceFile);
      const method = node.expression.name.text.toUpperCase();
      const [pathArg, ...rest] = node.arguments;
      const path = pathArg?.getText(sourceFile).replace(/^["'`]|["'`]$/g, "") ?? "";
      const middleware = rest.slice(0, -1).map((arg) => arg.getText(sourceFile)).join(" ").replace(/\s+/g, " ");
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      routes.push({
        key: `${name} ${method} ${path}${receiver === "router" ? "" : ` [${receiver}]`}`,
        where: `${name}:${line + 1}`,
        middleware,
        source: `${middleware}\n${rest.at(-1)?.getText(sourceFile) ?? ""}`,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

const problems = [];
const byKey = new Map();
for (const route of routes) byKey.set(route.key, [...(byKey.get(route.key) ?? []), route]);

for (const route of routes) {
  const entry = EXCEPTIONS[route.key];
  const guarded = VIEWER_GUARD.test(route.middleware);
  if (!entry) {
    if (!guarded) {
      problems.push(`${route.where} ${route.key}: mutation route without denyViewers or an admin/consultant guard `
        + `(${route.middleware || "no middleware"}). Add the guard, or list it in EXCEPTIONS with its token or account check.`);
    }
    continue;
  }
  if (guarded) {
    problems.push(`${route.where} ${route.key}: now has a viewer guard; remove its exception.`);
    continue;
  }
  const missing = entry.proof.filter((pattern) => !pattern.test(route.source));
  if (missing.length) {
    problems.push(`${route.where} ${route.key}: listed as "${entry.mechanism}" but no longer matches `
      + `${missing.map(String).join(", ")}. Re-review the route and update or remove its exception.`);
  }
}
for (const key of Object.keys(EXCEPTIONS)) {
  const matches = byKey.get(key) ?? [];
  if (!matches.length) problems.push(`${key}: exception has no matching route (remove it).`);
  if (matches.length > 1) {
    problems.push(`${key}: exception matches ${matches.length} routes (${matches.map((route) => route.where).join(", ")}); make it name one.`);
  }
}

const mechanisms = new Map();
for (const entry of Object.values(EXCEPTIONS)) mechanisms.set(entry.mechanism, (mechanisms.get(entry.mechanism) ?? 0) + 1);
console.log(`Checked ${routes.length} POST/PUT/PATCH/DELETE route declarations.`);
console.log(`Route-level exceptions: ${Object.keys(EXCEPTIONS).length} (${[...mechanisms].map(([mechanism, count]) => `${mechanism} ${count}`).join(", ")}).`);
if (problems.length) {
  console.error("\nViewer route policy problems:");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log("All business mutations declare denyViewers or an admin/consultant role guard; every exception names one route and still matches its check.");
