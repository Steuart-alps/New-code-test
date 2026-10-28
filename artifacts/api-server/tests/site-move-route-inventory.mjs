// Structural guardrail for department site moves.
//
// Every PUT/PATCH route, and every POST on an existing record, whose handler
// handles a siteId must be listed below with how its department boundary is
// proven. A handler counts when it names siteId itself or reaches it through a
// declaration in the same file (a body schema such as updateSchema, or a helper
// it calls), so a schema that lets siteId through a spread is caught too:
//   covered    - an integration check shows department staff cannot move the
//                record to another department's site: either a check label
//                in a test file, or a record name passed to the siteMove
//                helper in tests/stored-track-lock.mjs ("site move: <name>");
//   adminOnly  - the route is mounted behind an admin/consultant guard;
//   notAMove   - the handler reads a site but never moves a record (status
//                or workflow actions, per-site settings, site in the path);
//   gap        - a known gap, with the reason it is not covered yet.
// A new route that is not listed, a stale entry, a missing check label or an
// adminOnly route without an admin guard fails this check (run by typecheck).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const lock = "stored-track-lock.mjs";
const covered = (label, file = lock) => ({ covered: { file, label } });
const siteMove = (name) => ({ covered: { file: lock, label: name, siteMove: true } });
const adminOnly = (reason) => ({ adminOnly: reason });
const notAMove = (reason) => ({ notAMove: reason });
const gap = (reason) => ({ gap: reason });

const INVENTORY = {
  "bike-track.ts PUT /bikes/:id": siteMove("BikeTrack bike"),
  "bike-track.ts PUT /hires/:id": siteMove("BikeTrack hire"),
  "certificates.ts POST /items/:itemId/certificates": adminOnly("certificate outcomes"),
  "certificates.ts POST /items/:itemId/certificates/:id/defects": adminOnly("certificate defects"),
  "checklist-templates.ts PUT /checklist-templates": adminOnly("checklist template editor"),
  "compliance-items.ts PATCH /compliance-items/:id/status": notAMove("status-only; checks the item's stored site"),
  "compliance-items.ts PUT /compliance-items/:id": adminOnly("compliance item editor"),
  "contractor-visits.ts PUT /contractor-visits": adminOnly("chooses the contractor reminded about a visit at a site"),
  "contractor-sign-in.ts POST /:token/sign-in": notAMove("contractor signs in at the link's own site; no site comes from the caller"),
  "contractor-sign-in.ts POST /:token/visit": notAMove("reads the contractor's own visit at the link's site"),
  "contractor-sign-in.ts POST /:token/sign-out": notAMove("signs the contractor out; the visit keeps its site"),
  "contractor-sign-in.ts PUT /sites/:siteId": notAMove("per-site settings; site is addressed in the path and access-checked"),
  "contractor-sign-in.ts POST /sites/:siteId/reset-link": notAMove("per-site link; site is addressed in the path and access-checked"),
  "contractor-sign-in.ts POST /sites/:siteId/email-link": notAMove("emails the link of a site addressed in the path and access-checked"),
  "contractor-sign-in.ts POST /visits/:id/sign-out": notAMove("signs a visit out at a site the caller can see; the visit keeps its site"),
  "csv-imports.ts POST /imports/list-reading/:kind/read": notAMove("siteId only tells the AI reader which site a list is for; nothing is stored"),
  "daily-checklists.ts POST /daily-checklists/:siteId/:date/:type": notAMove("site is addressed in the path and access-checked"),
  "daily-checklists.ts POST /daily-checklists/:siteId/:date/pm/sign-off": notAMove("site is addressed in the path and access-checked"),
  "coshh-track.ts PUT /assessments/:id": siteMove("COSHH assessment"),
  "coshh-track.ts PUT /checks/:id": siteMove("COSHH check"),
  "daily-track-am.ts PUT /:id": siteMove("DailyTrack AM checklist"),
  "daily-track-pm.ts PUT /:id": siteMove("DailyTrack PM checklist"),
  "daily-track-pm.ts PUT /signoffs/:id": siteMove("DailyTrack PM sign-off"),
  "doc-track.ts PATCH /documents/:id": covered("scoped staff cannot PATCH DocTrack site", "doc-track-signoff-status.mjs"),
  "equipment.ts PUT /equipment/:id": covered("scoped manager cannot move equipment to another department's site", "equipment-labels.mjs"),
  "fire-safety.ts PUT /:id": siteMove("Fire check"),
  "inspection-reports.ts POST /inspection-reports/:id/read": notAMove("reads the report on its stored site; suggested sites are checked again when the list is saved or confirmed"),
  "inspection-reports.ts PUT /inspection-reports/:id/draft": covered("scoped manager cannot save report actions for another department's site", "inspection-reports.mjs"),
  "inspection-reports.ts POST /inspection-reports/:id/confirm": covered("scoped manager cannot confirm report actions for another department's site", "inspection-reports.mjs"),
  "fire-safety.ts PUT /call-points/:id": notAMove("renames or archives; the call point keeps its site"),
  "fire-safety.ts PUT /call-points/order": notAMove("reorders one site's call points, access-checked; none changes site"),
  "fire-safety.ts PUT /config": notAMove("per-site settings selected by query"),
  "fix-track-public.ts POST /:token/booked": notAMove("contractor's visit date on the issue's stored site; the site is only read to address the bell notice"),
  "fix-track-public.ts POST /:token": notAMove("contractor marks the issue done on its stored site; the site is only read to address the bell notice"),
  "fix-track.ts POST /issues/:id/assign-contractor": notAMove("gives the issue to a contractor on its stored site"),
  "fix-track.ts POST /quotes/:quoteId/accept": notAMove("accepts a quote on an issue the caller's department can see; the issue keeps its site"),
  "fix-track.ts POST /issues/:id/media": notAMove("workflow action on the issue's stored site"),
  "fix-track.ts POST /issues/:id/media/delete": notAMove("removes a photo or video from the issue on its stored site"),
  "fix-track.ts POST /issues/:id/reject-send": notAMove("workflow action on the issue's stored site"),
  "fix-track.ts POST /issues/:id/request-cancellation": notAMove("workflow action on the issue's stored site"),
  "fix-track.ts POST /issues/:id/request-send": notAMove("workflow action on the issue's stored site"),
  "fix-track.ts POST /issues/:id/request-upload": notAMove("workflow action on the issue's stored site"),
  "fix-track.ts PUT /issues/:id": siteMove("FixTrack issue"),
  "food-safety.ts PUT /:id": notAMove("the record's site is not editable"),
  "departments.ts PUT /departments/:id": adminOnly("moves a department under another site"),
  "food-safety.ts PUT /config": adminOnly("diary template settings"),
  "green-track.ts PUT /machines/:id": adminOnly("machine register"),
  "hot-tub.ts PUT /:id": covered("scoped staff cannot move HotTub check"),
  "hot-tub.ts PUT /config": adminOnly("HotTub settings"),
  "hot-tub.ts PUT /tubs/:id": covered("scoped staff cannot move HotTub asset"),
  "incidents.ts PUT /:id": siteMove("Incident"),
  "kitchen-cleaning.ts PUT /tasks/:id": siteMove("KitchenCleaning task"),
  "kitchen-weekly.ts PUT /probe/:id": siteMove("KitchenWeekly probe"),
  "kitchen-weekly.ts PUT /weekly/:id": covered("scoped staff cannot move current KitchenWeekly record"),
  "legionella.ts PUT /:id": covered("scoped staff cannot move current Legionella record"),
  "legionella.ts PUT /config": adminOnly("Legionella settings"),
  "legionella.ts PUT /outlets/:id": siteMove("Legionella outlet"),
  "notifications.ts POST /notifications/send-reminder/:itemId": adminOnly("manual reminder"),
  "pat-track.ts POST /failures/:id/location-corrections": adminOnly("failure location corrections"),
  "pat-track.ts PUT /appliances/:id": siteMove("PAT appliance"),
  "pat-track.ts PUT /certificates/:id": siteMove("PAT certificate"),
  "pat-track.ts PUT /equipment-templates/:id": siteMove("PAT equipment template"),
  "pat-track.ts PUT /failures/:id": notAMove("a failure keeps its certificate's site; reassignment is refused (409)"),
  "pat-track.ts PUT /replacements/:id": covered("scoped staff cannot move PAT replacement to another department's room"),
  "pat-track.ts PUT /rooms/:id": siteMove("PAT room"),
  "pat-track.ts PUT /tests/:id": notAMove("a test keeps its appliance's site; reassignment is refused (409)"),
  "pest-track.ts PUT /activity/:id": siteMove("PestTrack activity"),
  "pest-track.ts PUT /visits/:id": siteMove("PestTrack visit"),
  "pool-track.ts PUT /:id": siteMove("Pool check"),
  "pool-track.ts PUT /config": notAMove("per-site settings selected by query"),
  "premises-track.ts PUT /:id": covered("scoped staff cannot move Premises inspection"),
  "track-owners.ts PUT /track-owners": adminOnly("track owners"),
  "registers.ts POST /asbestos/:id/entries": notAMove("entry belongs to an asbestos record the caller can see; no site field"),
  "allergen-recipes.ts PUT /allergen-ingredients/:id": covered("scoped staff cannot move an ingredient to another department's site", "allergen-recipes.mjs"),
  "allergen-recipes.ts PUT /allergen-menus/:id": notAMove("renames only; a menu stays at its site"),
  "registers.ts PUT /allergens/:id": siteMove("Allergen register item"),
  "registers.ts PUT /asbestos/:id": siteMove("Asbestos register item"),
  "registers.ts PUT /asbestos/entries/:entryId": notAMove("entry belongs to an asbestos record the caller can see; no site field"),
  "registers.ts PUT /coshh/:id": siteMove("COSHH register item"),
  "room-track.ts PUT /checks/:id": covered("scoped staff cannot move Room check"),
  "room-track.ts PUT /rooms/:id": adminOnly("room register"),
  // crudFor serves risk assessments, SOPs, training, inductions, competency
  // and handbook with one handler; the training record exercises it.
  "safe-track.ts PUT /:id": siteMove("SafeTrack training record"),
  "sites.ts PATCH /sites/:id": adminOnly("site editor (department checked against the site)"),
  "sites.ts POST /sites/:id/documents": adminOnly("site documents"),
  "sites.ts POST /sites/:id/documents/request-upload": adminOnly("site documents"),
  "staff-roster.ts PATCH /staff-roster/:id": adminOnly("staff roster"),
  "swim-track.ts PUT /first-aid/:id": siteMove("Swim first-aid"),
  "swim-track.ts PUT /incidents/:id": siteMove("Swim incident"),
  "swim-track.ts PUT /sessions/:id": siteMove("Swim session"),
  "swim-track.ts PUT /surveillance/:id": siteMove("Swim surveillance"),
  "tasks.ts PATCH /tasks/:id": siteMove("Staff task"),
  "tasks.ts POST /tasks/:id/complete": notAMove("completion on a visible task; no site field"),
  "track-actions.ts PATCH /:id": covered("scoped staff cannot PATCH track action site"),
  "track-actions.ts PATCH /templates/:id": adminOnly("action templates"),
  "track-actions.ts POST /:id/fix-track": notAMove("FixTrack decision on the action's stored site"),
  "track-actions.ts POST /:id/media": notAMove("attaches a photo or video to the action on its stored site"),
  "track-actions.ts POST /:id/request-upload": notAMove("upload link for the action on its stored site"),
  "track-evidence.ts POST /:id/review": notAMove("evidence review on the action's stored site"),
  "train-track.ts PATCH /records/:id": covered("scoped staff cannot PATCH TrainTrack site"),
  "tree-track.ts PUT /:id": siteMove("Tree inspection"),
};

const ADMIN_GUARD = /\brequire(?:ClientAdmin|Consultant)\b|\brequireRole\(\s*["']client_admin["']/;
const routesDirectory = fileURLToPath(new URL("../src/routes", import.meta.url));
const testsDirectory = fileURLToPath(new URL(".", import.meta.url));
const routeFiles = execFileSync("find", [routesDirectory, "-maxdepth", "1", "-name", "*.ts", "-print"], { encoding: "utf8" })
  .trim().split("\n").filter(Boolean).sort();

const found = new Map();
for (const file of routeFiles) {
  const name = basename(file);
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
    }
  }
  // True when the handler, or any same-file declaration it references
  // (transitively), mentions siteId.
  const reachesSiteId = (handler) => {
    const seen = new Set();
    const queue = [handler];
    while (queue.length) {
      const node = queue.shift();
      if (/\bsiteId\b/.test(node.getText(sourceFile))) return true;
      const walk = (child) => {
        if (ts.isIdentifier(child) && declarations.has(child.text) && !seen.has(child.text)) {
          seen.add(child.text);
          queue.push(declarations.get(child.text));
        }
        ts.forEachChild(child, walk);
      };
      walk(node);
    }
    return false;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(?:router|sub|\w+Router)$/.test(node.expression.expression.getText(sourceFile))
      && ["put", "patch", "post"].includes(node.expression.name.text)) {
      const method = node.expression.name.text.toUpperCase();
      const [pathArg, ...rest] = node.arguments;
      const path = pathArg?.getText(sourceFile).replace(/^["'`]|["'`]$/g, "") ?? "";
      const handler = rest.at(-1);
      const middleware = rest.slice(0, -1).map((arg) => arg.getText(sourceFile)).join(" ");
      // A POST without a path parameter creates a record rather than moving one.
      if (handler && reachesSiteId(handler) && (method !== "POST" || /:\w+/.test(path))) {
        found.set(`${name} ${method} ${path}`, { middleware });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const problems = [];
const testSources = new Map();
const testSource = (file) => {
  if (!testSources.has(file)) testSources.set(file, readFileSync(`${testsDirectory}${file}`, "utf8"));
  return testSources.get(file);
};
for (const [key, route] of found) {
  const entry = INVENTORY[key];
  if (!entry) {
    problems.push(`${key}: handles siteId but is not in the site-move inventory. Add a department move check `
      + `(see "site move:" in tests/${lock}) and list it here, or classify it.`);
    continue;
  }
  if (entry.covered && !testSource(entry.covered.file).includes(`"${entry.covered.label}"`)) {
    problems.push(`${key}: ${entry.covered.siteMove ? "siteMove record" : "check"} "${entry.covered.label}" `
      + `was not found in tests/${entry.covered.file}`);
  }
  if (entry.adminOnly && !ADMIN_GUARD.test(route.middleware)) {
    problems.push(`${key}: listed as admin-only but has no admin guard (${route.middleware || "no middleware"})`);
  }
}
for (const key of Object.keys(INVENTORY)) {
  if (!found.has(key)) problems.push(`${key}: listed in the inventory but no longer handles siteId (remove it)`);
}

const count = (kind) => Object.values(INVENTORY).filter((entry) => entry[kind]).length;
console.log(`Site-move routes: ${found.size} (covered ${count("covered")}, admin-only ${count("adminOnly")}, `
  + `not a move ${count("notAMove")}, known gaps ${count("gap")}).`);
for (const [key, entry] of Object.entries(INVENTORY)) {
  if (entry.gap) console.log(`Known gap: ${key} - ${entry.gap}`);
}
if (problems.length) {
  console.error("\nSite-move route inventory problems:");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log("Every site-accepting route is covered, admin-only, not a move, or a documented gap.");
