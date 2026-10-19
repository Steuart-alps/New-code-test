// Owner and Manager roles. Run through test:manager-role (self-booted API).
//  - Sign-up makes the person their business's Owner (client_admin), not a consultant.
//  - A Manager lists, adds, edits and removes only the Staff and Viewers in
//    their own department; everyone else answers like a missing user.
//  - A Manager can't give Owner/Manager rights, every department or the
//    maintenance switch, can't change their own role, and has no billing,
//    settings, sites or 2FA resets.
//  - A Manager given every department sees all departments' Staff and sites.
//  - A Manager (or Maintenance manager) given several departments looks after
//    the people in all of them and switches between them for everything else.
//  - A Viewer is linked to a staff roster entry of their own business.
//  - A consultant on the PLATFORM_ADMIN_EMAILS list (ALPS's own sign-in) sees
//    every business, with its sites on the Portfolio; other consultants see
//    only the businesses they're linked to.
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";
import { promoteToConsultant } from "./consultant-account.mjs";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required");
const ownership = createFixtureOwnership({ runId: resolveRunId(), suite: "manager-role" });
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function session() {
  let cookie = "";
  const call = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return call;
}

const email = (label) => `manager-role-${label}-${ownership.runId}@test.local`;

async function signUp(label, address = email(label)) {
  const call = session();
  const registered = await call("POST", "/auth/register", { name: `${label} Owner`, email: address, password: "password-123" });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  ownership.trackRegisteredUser();
  await call("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data?.verificationToken ?? "")}`);
  const login = await call("POST", "/auth/login", { email: address, password: "password-123" });
  check(`${label}: login`, login.status === 200, String(login.status));
  const me = await call("GET", "/auth/me");
  call.user = me.data?.user ?? me.data;
  call.clientId = call.user?.clientId;
  ownership.trackClient(call.clientId);
  return call;
}

async function member(owner, label, role, extra = {}) {
  const created = await owner("POST", "/users", { name: `${label} person`, email: email(label), password: "password-456", role, clientId: owner.clientId, ...extra });
  check(`${label}: create ${role}`, created.status === 201, JSON.stringify(created.data));
  ownership.trackRegisteredUser();
  return created.data;
}

async function signIn(label) {
  const call = session();
  const login = await call("POST", "/auth/login", { email: email(label), password: "password-456" });
  check(`${label}: login`, login.status === 200, String(login.status));
  return call;
}

async function main() {
  try {
    await roles();
  } finally {
    await ownership.cleanup();
  }
  console.log(`${passed} manager-role checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

async function roles() {
  const owner = await signUp("owner");
  check("sign-up makes an Owner, not a consultant", owner.user?.role === "client_admin", JSON.stringify(owner.user));
  const clients = await owner("GET", "/clients");
  check("an Owner has no consultant business list", clients.status === 403, String(clients.status));

  const kitchen = await owner("POST", "/departments", { name: "Kitchen", clientId: owner.clientId });
  const rooms = await owner("POST", "/departments", { name: "Housekeeping", clientId: owner.clientId });
  check("owner creates departments", kitchen.status === 201 && rooms.status === 201, `${kitchen.status} ${rooms.status}`);
  const kitchenId = kitchen.data?.id;
  const roomsId = rooms.data?.id;
  const kitchenSite = await owner("POST", "/sites", { name: "Main kitchen", departmentId: kitchenId, clientId: owner.clientId });
  const roomsSite = await owner("POST", "/sites", { name: "East wing", departmentId: roomsId, clientId: owner.clientId });
  check("owner creates sites", kitchenSite.status === 201 && roomsSite.status === 201, `${kitchenSite.status} ${roomsSite.status}`);

  const consultant = await owner("POST", "/users", { name: "Not allowed", email: email("consultant"), password: "password-456", role: "consultant", clientId: owner.clientId });
  check("an Owner can't create a consultant", consultant.status === 403, String(consultant.status));
  const allOnStaff = await owner("POST", "/users", { name: "Not allowed", email: email("allstaff"), password: "password-456", role: "client_staff", clientId: owner.clientId, allDepartments: true });
  check("every department is for Managers only (create is stored false)", allOnStaff.status === 201 && allOnStaff.data?.allDepartments === false, JSON.stringify(allOnStaff.data));
  ownership.trackRegisteredUser();

  const manager = await member(owner, "head-chef", "client_manager", { departmentId: kitchenId });
  const chef = await member(owner, "chef", "client_staff", { departmentId: kitchenId });
  const auditor = await member(owner, "auditor", "client_viewer", { departmentId: kitchenId });
  const cleaner = await member(owner, "cleaner", "client_staff", { departmentId: roomsId });
  const secondOwner = await member(owner, "co-owner", "client_admin");
  const generalManager = await member(owner, "general-manager", "client_manager", { allDepartments: true });
  check("an Owner gives a Manager every department", generalManager?.allDepartments === true, JSON.stringify(generalManager));
  const fixer = await member(owner, "fixer", "client_staff", { departmentId: roomsId, isMaintenanceManager: true });
  check("an Owner adds a maintenance manager in one step", fixer?.isMaintenanceManager === true, JSON.stringify(fixer));
  const staffAll = await owner("PUT", `/users/${chef?.id}`, { allDepartments: true });
  check("an Owner can't give Staff every department", staffAll.status === 400, String(staffAll.status));

  const head = await signIn("head-chef");
  const list = await head("GET", "/users");
  const ids = new Set((list.data ?? []).map((u) => u.id));
  check("Manager sees the Users list", list.status === 200, String(list.status));
  check("Manager sees themselves and their department's Staff and Viewers",
    ids.has(manager?.id) && ids.has(chef?.id) && ids.has(auditor?.id), JSON.stringify([...ids]));
  check("Manager doesn't see other departments, Owners or other Managers",
    !ids.has(cleaner?.id) && !ids.has(secondOwner?.id) && !ids.has(generalManager?.id) && !ids.has(fixer?.id), JSON.stringify([...ids]));

  const added = await head("POST", "/users", { name: "Commis chef", email: email("commis"), password: "password-456", role: "client_staff", clientId: owner.clientId });
  check("Manager adds Staff", added.status === 201, JSON.stringify(added.data));
  check("Manager's new Staff start in the Manager's department", added.data?.departmentId === kitchenId, JSON.stringify(added.data));
  ownership.trackRegisteredUser();
  for (const [label, body] of [
    ["another department", { role: "client_staff", departmentId: roomsId }],
    ["no department", { role: "client_staff", departmentId: null }],
    ["an Owner", { role: "client_admin", departmentId: kitchenId }],
    ["a Manager", { role: "client_manager", departmentId: kitchenId }],
    ["a consultant", { role: "consultant", departmentId: kitchenId }],
    ["every department", { role: "client_staff", departmentId: kitchenId, allDepartments: true }],
    ["the maintenance switch", { role: "client_staff", departmentId: kitchenId, isMaintenanceManager: true }],
  ]) {
    const refused = await head("POST", "/users", { name: "Refused", email: email(`refused-${label.replace(/\W+/g, "-")}`), password: "password-456", clientId: owner.clientId, ...body });
    check(`Manager can't add someone with ${label}`, refused.status === 403, `${refused.status} ${JSON.stringify(refused.data)}`);
  }

  const rename = await head("PUT", `/users/${chef?.id}`, { name: "Sous chef" });
  check("Manager edits their Staff", rename.status === 200 && rename.data?.name === "Sous chef", JSON.stringify(rename.data));
  const viewerToStaff = await head("PUT", `/users/${auditor?.id}`, { role: "client_staff" });
  check("Manager switches a Viewer to Staff", viewerToStaff.status === 200, String(viewerToStaff.status));
  const promote = await head("PUT", `/users/${chef?.id}`, { role: "client_admin" });
  check("Manager can't make Staff an Owner", promote.status === 403, String(promote.status));
  const promoteManager = await head("PUT", `/users/${chef?.id}`, { role: "client_manager" });
  check("Manager can't make Staff a Manager", promoteManager.status === 403, String(promoteManager.status));
  const move = await head("PUT", `/users/${chef?.id}`, { departmentId: roomsId });
  check("Manager can't move Staff to another department", move.status === 403, String(move.status));
  const flag = await head("PUT", `/users/${chef?.id}`, { isMaintenanceManager: true });
  check("Manager can't switch on maintenance access", flag.status === 403, String(flag.status));
  for (const [label, target] of [["another department's Staff", cleaner], ["an Owner", secondOwner], ["another Manager", generalManager]]) {
    const edit = await head("PUT", `/users/${target?.id}`, { name: "Changed" });
    check(`Manager can't edit ${label} (answers like a missing user)`, edit.status === 404, String(edit.status));
    const remove = await head("DELETE", `/users/${target?.id}`);
    check(`Manager can't remove ${label}`, remove.status === 404, String(remove.status));
    const resend = await head("POST", `/users/${target?.id}/resend-invite`);
    check(`Manager can't send ${label} a setup link`, resend.status === 404, String(resend.status));
  }
  const selfName = await head("PUT", `/users/${manager?.id}`, { name: "Head Chef" });
  check("Manager updates their own name", selfName.status === 200, String(selfName.status));
  const selfRole = await head("PUT", `/users/${manager?.id}`, { role: "client_admin" });
  check("Manager can't change their own role", selfRole.status === 403, String(selfRole.status));
  const selfAll = await head("PUT", `/users/${manager?.id}`, { allDepartments: true });
  check("Manager can't give themselves every department", selfAll.status === 403, String(selfAll.status));
  const selfMove = await head("PUT", `/users/${manager?.id}`, { departmentId: roomsId });
  check("Manager can't move themselves to another department", selfMove.status === 403, String(selfMove.status));
  const removed = await head("DELETE", `/users/${added.data?.id}`);
  check("Manager removes their own Staff", removed.status === 200, JSON.stringify(removed.data));

  const reset2fa = await head("POST", `/users/${chef?.id}/reset-2fa`);
  check("Manager can't reset two-step sign-in", reset2fa.status === 403, String(reset2fa.status));
  const invoices = await head("GET", "/billing/invoices");
  check("Manager has no billing", invoices.status === 403, String(invoices.status));
  const settings = await head("PUT", "/settings", { accountTimezone: "Europe/London" });
  check("Manager can't change settings", settings.status === 403, String(settings.status));
  const newSite = await head("POST", "/sites", { name: "Not allowed", clientId: owner.clientId });
  check("Manager can't add sites", newSite.status === 403, String(newSite.status));
  const department = await head("POST", "/departments", { name: "Not allowed", clientId: owner.clientId });
  check("Manager can't add departments", department.status === 403, String(department.status));
  const sites = await head("GET", "/sites");
  const siteIds = new Set((sites.data ?? []).map((s) => s.id));
  check("Manager sees their department's sites only",
    siteIds.has(kitchenSite.data?.id) && !siteIds.has(roomsSite.data?.id), JSON.stringify([...siteIds]));

  const general = await signIn("general-manager");
  const generalList = await general("GET", "/users");
  const generalIds = new Set((generalList.data ?? []).map((u) => u.id));
  check("An all-departments Manager sees every department's Staff",
    generalIds.has(chef?.id) && generalIds.has(cleaner?.id), JSON.stringify([...generalIds]));
  check("An all-departments Manager still doesn't see Owners or other Managers",
    !generalIds.has(secondOwner?.id) && !generalIds.has(manager?.id), JSON.stringify([...generalIds]));
  const generalSites = new Set(((await general("GET", "/sites")).data ?? []).map((s) => s.id));
  check("An all-departments Manager sees every site",
    generalSites.has(kitchenSite.data?.id) && generalSites.has(roomsSite.data?.id), JSON.stringify([...generalSites]));
  const generalMove = await general("PUT", `/users/${cleaner?.id}`, { departmentId: kitchenId });
  check("An all-departments Manager moves Staff between departments", generalMove.status === 200, String(generalMove.status));

  const demote = await owner("PUT", `/users/${generalManager?.id}`, { role: "client_staff" });
  check("Changing a Manager to Staff drops every-department access", demote.status === 200 && demote.data?.allDepartments === false, JSON.stringify(demote.data));

  // Another business's Manager can't reach this one's people.
  const other = await signUp("other-owner");
  await member(other, "other-head", "client_manager");
  const otherHead = await signIn("other-head");
  const crossEdit = await otherHead("PUT", `/users/${chef?.id}`, { name: "Changed" });
  check("Another business's Manager can't edit this business's Staff", [403, 404].includes(crossEdit.status), String(crossEdit.status));

  await severalDepartments({ owner, other, kitchenId, roomsId, kitchenSite: kitchenSite.data, roomsSite: roomsSite.data, chef, cleaner });
  await everyBusiness({ owner, other, siteNames: ["Main kitchen", "East wing"] });
}

async function severalDepartments({ owner, other, kitchenId, roomsId, kitchenSite, roomsSite, chef, cleaner }) {
  const both = await member(owner, "ops-manager", "client_manager", { departmentIds: [roomsId, kitchenId] });
  check("an Owner gives a Manager several departments, main first",
    both?.departmentId === roomsId && JSON.stringify(both?.departmentIds) === JSON.stringify([roomsId, kitchenId]), JSON.stringify(both));
  const staffTwo = await owner("POST", "/users", { name: "Refused", email: email("staff-two"), password: "password-456", role: "client_staff", clientId: owner.clientId, departmentIds: [kitchenId, roomsId] });
  check("only Managers get more than one department", staffTwo.status === 400, String(staffTwo.status));
  const foreignDept = await other("POST", "/departments", { name: "Elsewhere", clientId: other.clientId });
  const withForeign = await owner("POST", "/users", { name: "Refused", email: email("foreign-dept"), password: "password-456", role: "client_manager", clientId: owner.clientId, departmentIds: [kitchenId, foreignDept.data?.id] });
  check("another business's department can't be given", withForeign.status === 400, String(withForeign.status));

  const ops = await signIn("ops-manager");
  const me = (await ops("GET", "/auth/me")).data?.user;
  check("/auth/me lists the Manager's departments and the one they're in",
    me?.departmentId === roomsId && JSON.stringify(me?.departmentIds) === JSON.stringify([roomsId, kitchenId]), JSON.stringify(me));
  const people = new Set(((await ops("GET", "/users")).data ?? []).map((u) => u.id));
  check("the Manager looks after Staff in all their departments", people.has(chef?.id) && people.has(cleaner?.id), JSON.stringify([...people]));
  const siteIds = async () => new Set(((await ops("GET", "/sites")).data ?? []).map((site) => site.id));
  let visible = await siteIds();
  check("they start in their main department", visible.has(roomsSite?.id) && !visible.has(kitchenSite?.id), JSON.stringify([...visible]));
  const switched = await ops("PUT", "/users/me/active-department", { departmentId: kitchenId });
  check("they switch to another of their departments", switched.status === 200 && switched.data?.departmentId === kitchenId, JSON.stringify(switched.data));
  visible = await siteIds();
  check("after switching they see that department's sites", visible.has(kitchenSite?.id) && !visible.has(roomsSite?.id), JSON.stringify([...visible]));
  check("/auth/me shows the department they switched to", (await ops("GET", "/auth/me")).data?.user?.departmentId === kitchenId);
  const notTheirs = await ops("PUT", "/users/me/active-department", { departmentId: foreignDept.data?.id });
  check("they can't switch to a department that isn't theirs", notTheirs.status === 404, String(notTheirs.status));
  const ownerSwitch = await owner("PUT", "/users/me/active-department", { departmentId: kitchenId });
  check("the department switch is for Managers", ownerSwitch.status === 403, String(ownerSwitch.status));
  const selfEdit = await ops("PUT", `/users/${both?.id}`, { name: "Ops Manager", departmentId: kitchenId });
  check("a Manager renames themselves from the department they're in", selfEdit.status === 200 && selfEdit.data?.departmentId === roomsId, JSON.stringify(selfEdit.data));
  const widen = await ops("PUT", `/users/${both?.id}`, { departmentIds: [kitchenId] });
  check("a Manager can't change their own departments", widen.status === 403, String(widen.status));

  const narrowed = await owner("PUT", `/users/${both?.id}`, { departmentIds: [kitchenId] });
  check("an Owner narrows a Manager to one department", narrowed.status === 200 && JSON.stringify(narrowed.data?.departmentIds) === JSON.stringify([kitchenId]), JSON.stringify(narrowed.data));
  visible = await siteIds();
  check("a removed department disappears at once", visible.has(kitchenSite?.id) && !visible.has(roomsSite?.id), JSON.stringify([...visible]));
  const restored = await owner("PUT", `/users/${both?.id}`, { departmentIds: [kitchenId, roomsId] });
  check("an Owner adds a department back", JSON.stringify(restored.data?.departmentIds) === JSON.stringify([kitchenId, roomsId]), JSON.stringify(restored.data));
  const toStaff = await owner("PUT", `/users/${both?.id}`, { role: "client_staff" });
  check("changing a Manager to Staff keeps only their main department",
    toStaff.status === 200 && JSON.stringify(toStaff.data?.departmentIds) === JSON.stringify([kitchenId]), JSON.stringify(toStaff.data));

  const maintenance = await member(owner, "maintenance-lead", "client_manager", { departmentIds: [kitchenId, roomsId], isMaintenanceManager: true });
  check("a Maintenance manager is a Manager with several departments",
    maintenance?.role === "client_manager" && maintenance?.isMaintenanceManager === true && maintenance?.departmentIds?.length === 2, JSON.stringify(maintenance));

  // Viewers are linked to their own business's staff roster.
  const ownEntry = await owner("POST", "/staff-roster", { name: "Roster person", email: email("roster-viewer") });
  const foreignEntry = await other("POST", "/staff-roster", { name: "Foreign person" });
  check("roster entries created", ownEntry.status === 201 && foreignEntry.status === 201, `${ownEntry.status} ${foreignEntry.status}`);
  const matched = await member(owner, "roster-viewer", "client_viewer", { departmentId: kitchenId });
  check("a new Viewer is linked to the roster entry with their email", matched?.staffRosterId === ownEntry.data?.id, JSON.stringify(matched));
  const foreignLink = await owner("PUT", `/users/${matched?.id}`, { staffRosterId: foreignEntry.data?.id });
  check("a Viewer can't be linked to another business's roster", foreignLink.status === 400, String(foreignLink.status));
  const staffLink = await owner("PUT", `/users/${chef?.id}`, { staffRosterId: ownEntry.data?.id });
  check("only Viewers are linked to the roster", staffLink.status === 400, String(staffLink.status));
}

async function everyBusiness({ owner, other, siteNames }) {
  const operatorEmail = process.env.PLATFORM_OPERATOR_EMAIL;
  if (!operatorEmail) {
    console.log("PLATFORM_OPERATOR_EMAIL not set (API was already running); skipping every-business checks.");
    return;
  }
  const operator = await signUp("operator", operatorEmail);
  promoteToConsultant(operatorEmail);
  const adviser = await signUp("adviser");
  promoteToConsultant(email("adviser"));

  const operatorClients = new Set(((await operator("GET", "/clients")).data ?? []).map((c) => c.id));
  check("The platform operator's consultant login lists every business",
    operatorClients.has(owner.clientId) && operatorClients.has(other.clientId) && operatorClients.has(adviser.clientId),
    JSON.stringify([...operatorClients]));
  const portfolio = await operator("GET", "/portfolio");
  const business = (portfolio.data?.businesses ?? []).find((b) => b.id === owner.clientId);
  check("The operator's Portfolio includes an unlinked business", portfolio.status === 200 && !!business, JSON.stringify(portfolio.data));
  const listed = (business?.siteList ?? []).map((site) => site.name);
  check("The Portfolio lists each business's sites by name",
    siteNames.every((name) => listed.includes(name)) && business?.sites === listed.length, JSON.stringify(business));
  const sites = await operator("GET", `/sites?clientId=${owner.clientId}`);
  check("The operator can open any business's sites", sites.status === 200 && (sites.data ?? []).length === siteNames.length, `${sites.status} ${JSON.stringify(sites.data)}`);

  const adviserClients = new Set(((await adviser("GET", "/clients")).data ?? []).map((c) => c.id));
  check("Another consultant lists only their own businesses",
    adviserClients.has(adviser.clientId) && !adviserClients.has(owner.clientId), JSON.stringify([...adviserClients]));
  const adviserPortfolio = await adviser("GET", "/portfolio");
  check("Another consultant's Portfolio leaves out unlinked businesses",
    !(adviserPortfolio.data?.businesses ?? []).some((b) => b.id === owner.clientId), JSON.stringify(adviserPortfolio.data));
  const blocked = await adviser("GET", `/sites?clientId=${owner.clientId}`);
  check("Another consultant can't open an unlinked business", blocked.status === 403, String(blocked.status));

}

main().catch((error) => { console.error(error); process.exit(1); });
