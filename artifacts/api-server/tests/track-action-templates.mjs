// Integration coverage for the required-action template catalogue.
// Run through run-track-action-templates.sh to boot a disposable API when needed.
const BASE = process.env.API_BASE || "http://localhost:8080/api";
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let passed = 0; const failures = [];
const check = (name, ok, detail = "") => ok ? passed++ : (failures.push(`${name}${detail ? ` — ${detail}` : ""}`), console.error(`FAIL: ${name} ${detail}`));
const status = (name, response, expected) => check(name, expected.includes(response.status), `expected ${expected.join("/")} got ${response.status}`);
function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
    const data = (response.headers.get("content-type") || "").includes("application/json") ? await response.json().catch(() => null) : null;
    return { status: response.status, data };
  };
}
async function register(req, name, suffix) {
  const email = `action-template-${suffix}-${Date.now()}@test.local`;
  const registered = await req("POST", "/auth/register", { name, email, password: "password-123" });
  status(`${name} registers`, registered, [200, 201]);
  if (registered.data?.verificationToken) {
    status(`${name} verifies`, await req("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
    status(`${name} logs in`, await req("POST", "/auth/login", { email, password: "password-123" }), [200, 201]);
  }
  return req("GET", "/auth/me");
}
async function main() {
  const admin = session(); const me = await register(admin, "Template Admin", "admin");
  const clientId = (me.data?.user ?? me.data)?.clientId; check("admin has client", Number.isInteger(clientId));
  const alpha = await admin("POST", "/departments", { name: "Action Alpha" });
  const beta = await admin("POST", "/departments", { name: "Action Beta" }); status("create alpha department", alpha, [200, 201]); status("create beta department", beta, [200, 201]);
  const alphaSite = await admin("POST", "/sites", { name: "Action Alpha Site", departmentId: alpha.data?.id });
  const betaSite = await admin("POST", "/sites", { name: "Action Beta Site", departmentId: beta.data?.id });
  status("create alpha site", alphaSite, [200, 201]); status("create beta site", betaSite, [200, 201]);
  const template = (title, scope = {}) => admin("POST", "/track-actions/templates", { title, instruction: `${title} instruction`, severity: "urgent", ownerDefault: "Duty Manager", leadTimeDays: 2, module: "fire", ...scope });
  status("template rejects missing instruction", await admin("POST", "/track-actions/templates", { title: "bad", module: "fire" }), [400]);
  status("template rejects foreign scope", await template("bad scope", { siteId: 99999999 }), [400]);
  const global = await template("global", { module: null }); const moduleGlobal = await template("module global"); const dept = await template("alpha department", { departmentId: alpha.data?.id }); const site = await template("alpha site", { siteId: alphaSite.data?.id }); const combined = await template("alpha combined", { siteId: alphaSite.data?.id, departmentId: alpha.data?.id });
  for (const [name, result] of [["global", global], ["module global", moduleGlobal], ["department", dept], ["site", site], ["combined", combined]]) status(`create ${name} template`, result, [201]);
  const matched = await admin("GET", `/track-actions/templates/matching?module=fire&siteId=${alphaSite.data?.id}`); status("matching templates", matched, [200]);
  const matchedTitles = (matched.data || []).map(x => x.title);
  check("matching includes all applicable scopes", ["global", "module global", "alpha department", "alpha site", "alpha combined"].every(x => matchedTitles.includes(x)));
  check("matching specificity puts combined first", matchedTitles[0] === "alpha combined", matchedTitles.join(", "));
  check("module-specific beats module-global", matchedTitles.indexOf("module global") < matchedTitles.indexOf("global"), matchedTitles.join(", "));
  status("admin lists templates", await admin("GET", "/track-actions/templates"), [200]);
  status("active toggle", await admin("PATCH", `/track-actions/templates/${site.data?.id}`, { active: false }), [200]);
  const afterInactive = await admin("GET", `/track-actions/templates/matching?module=fire&siteId=${alphaSite.data?.id}`);
  check("inactive template excluded", !(afterInactive.data || []).some(x => x.id === site.data?.id));
  status("reorder templates", await admin("POST", "/track-actions/templates/reorder", { templateIds: [combined.data?.id, global.data?.id, moduleGlobal.data?.id, dept.data?.id, site.data?.id] }), [200]);
  status("reorder rejects duplicate IDs", await admin("POST", "/track-actions/templates/reorder", { templateIds: [global.data?.id, global.data?.id] }), [400]);
  const action = await admin("POST", "/track-actions", { module: "fire", templateId: combined.data?.id, siteId: alphaSite.data?.id });
  status("create action from template", action, [201]);
  check("template action snapshot fields", action.data?.title === "alpha combined" && action.data?.instruction === "alpha combined instruction" && action.data?.provenance === "template" && action.data?.ownerName === "Duty Manager");
  status("edit chosen template", await admin("PATCH", `/track-actions/templates/${combined.data?.id}`, { title: "changed template", instruction: "changed instruction", severity: "monitor" }), [200]);
  const actions = await admin("GET", `/track-actions?module=fire&siteId=${alphaSite.data?.id}`);
  const historic = (actions.data || []).find(x => x.id === action.data?.id); check("template edit does not alter action snapshot", historic?.title === "alpha combined" && historic?.severity === "urgent" && historic?.instruction === "alpha combined instruction");
  const declinedFix = await admin("POST", `/track-actions/${action.data?.id}/fix-track`, { create: false });
  status("action can stay in its originating track", declinedFix, [200]);
  check("declined FixTrack choice persists", declinedFix.data?.fixTrackDisposition === "not_needed");
  const linkedFix = await admin("POST", `/track-actions/${action.data?.id}/fix-track`, { create: true });
  status("action can create a linked FixTrack issue", linkedFix, [201]);
  const linkedIssueId = linkedFix.data?.fixTrackIssueId;
  check("FixTrack link is recorded", Number.isInteger(linkedIssueId) && linkedFix.data?.fixTrackDisposition === "linked");
  const duplicateFix = await admin("POST", `/track-actions/${action.data?.id}/fix-track`, { create: true });
  status("repeated FixTrack choice reuses the existing issue", duplicateFix, [200]);
  check("FixTrack link remains one-to-one", duplicateFix.data?.fixTrackIssueId === linkedIssueId);
  status("linked action cannot bypass FixTrack resolution", await admin("PATCH", `/track-actions/${action.data?.id}`, { status: "resolved", remedialAction: "bypass", evidenceReference: "bypass", resolutionNotes: "bypass", resolverSignature: SIGNATURE }), [409]);
  status("linked FixTrack issue cannot leave originating site", await admin("PUT", `/fix-track/issues/${linkedIssueId}`, { siteId: betaSite.data?.id }), [409]);
  status("linked FixTrack issue starts work", await admin("PUT", `/fix-track/issues/${linkedIssueId}`, { status: "in_progress" }), [200]);
  status("linked FixTrack issue resolves with signature", await admin("PUT", `/fix-track/issues/${linkedIssueId}`, { status: "resolved", resolverSignature: SIGNATURE, solutionNotes: "Repair completed" }), [200]);
  const syncedActions = await admin("GET", `/track-actions?module=fire&siteId=${alphaSite.data?.id}`);
  const syncedAction = (syncedActions.data || []).find(x => x.id === action.data?.id);
  check("FixTrack resolution completes original module action", syncedAction?.status === "resolved" && syncedAction?.resolvedByName === "Template Admin" && syncedAction?.resolverSignature === SIGNATURE, JSON.stringify(syncedAction));
  const greenAction = await admin("POST", "/track-actions", { module: "green", title: "Green-owned repair", severity: "action_required", siteId: alphaSite.data?.id });
  status("create GreenTrack action for exclusion check", greenAction, [201]);
  status("GreenTrack cannot be sent to FixTrack", await admin("POST", `/track-actions/${greenAction.data?.id}/fix-track`, { create: true }), [400]);
  const oneOff = await admin("POST", "/track-actions", { module: "fire", title: "one off", severity: "monitor", instruction: "one off instruction", siteId: alphaSite.data?.id });
  status("create one-off action", oneOff, [201]); check("one-off provenance", oneOff.data?.provenance === "one_off");
  status("resolution rejects missing evidence", await admin("PATCH", `/track-actions/${oneOff.data?.id}`, { status: "resolved", remedialAction: "fixed" }), [400]);
  status("resolution rejects missing signature", await admin("PATCH", `/track-actions/${oneOff.data?.id}`, { status: "resolved", remedialAction: "fixed", evidenceReference: "photo-1", resolutionNotes: "completed" }), [400]);
  const resolvedAction = await admin("PATCH", `/track-actions/${oneOff.data?.id}`, { status: "resolved", remedialAction: "fixed", evidenceReference: "photo-1", resolutionNotes: "completed", resolverSignature: SIGNATURE });
  status("resolution permits all evidence", resolvedAction, [200]);
  check("resolution snapshots authenticated resolver name", resolvedAction.data?.resolvedByName === "Template Admin", `got ${resolvedAction.data?.resolvedByName}`);
  check("resolution stores drawn signature", resolvedAction.data?.resolverSignature === SIGNATURE);

  const staffEmail = `action-staff-${Date.now()}@test.local`; const viewerEmail = `action-viewer-${Date.now()}@test.local`;
  status("create alpha staff", await admin("POST", "/users", { name: "Action staff", email: staffEmail, password: "password-123", role: "client_staff", clientId, departmentId: alpha.data?.id }), [200, 201]);
  status("create alpha viewer", await admin("POST", "/users", { name: "Action viewer", email: viewerEmail, password: "password-123", role: "client_viewer", clientId, departmentId: alpha.data?.id }), [200, 201]);
  const staff = session(); const viewer = session();
  status("staff login", await staff("POST", "/auth/login", { email: staffEmail, password: "password-123" }), [200, 201]);
  status("viewer login", await viewer("POST", "/auth/login", { email: viewerEmail, password: "password-123" }), [200, 201]);
  const staffMatch = await staff("GET", `/track-actions/templates/matching?module=fire&siteId=${alphaSite.data?.id}`); status("staff reads own department templates", staffMatch, [200]); check("staff sees alpha template", (staffMatch.data || []).some(x => x.id === combined.data?.id));
  status("staff cannot read beta site templates", await staff("GET", `/track-actions/templates/matching?module=fire&siteId=${betaSite.data?.id}`), [403]);
  status("staff cannot create beta-site action", await staff("POST", "/track-actions", { module: "fire", title: "wrong department", severity: "monitor", siteId: betaSite.data?.id }), [403]);
  status("viewer cannot create action", await viewer("POST", "/track-actions", { module: "fire", title: "denied", severity: "monitor" }), [403]);
  status("viewer cannot manage templates", await viewer("POST", "/track-actions/templates", { title: "denied", instruction: "denied", module: "fire" }), [403]);
  const other = session(); await register(other, "Other tenant", "other");
  status("other tenant cannot use template", await other("POST", "/track-actions", { module: "fire", templateId: combined.data?.id, siteId: alphaSite.data?.id }), [403, 404]);
  status("delete template", await admin("DELETE", `/track-actions/templates/${moduleGlobal.data?.id}`), [204]);
  console.log(`track-action template tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });