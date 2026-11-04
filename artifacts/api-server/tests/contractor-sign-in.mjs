// Contractor sign-in on arrival: a manager turns sign-in on for a site and
// sets its fire procedure; a contractor opens the site's link, reads the fire
// procedure and asbestos register, ticks, signs and later signs out; staff see
// who is on site and can sign someone out. Links belong to one site of one
// business, and Viewers and other businesses see nothing.
// Usage: npm run test:contractor-sign-in (boots its own API and database).
import { readFile, writeFile } from "node:fs/promises";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const today = new Date().toISOString().slice(0, 10);
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
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
  return async (method, path, body, raw = false) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    if (raw) return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}
const anonymous = session();

async function tenant(label) {
  const request = session();
  const email = `sign-in-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `${label} owner`, email, password: "password-123" });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  if (!registered.data?.verificationToken) throw new Error(`${label}: registration returned no verification token`);
  check(`${label}: verify`, (await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);
  check(`${label}: login`, (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  return request;
}

async function userSession(owner, label, role, clientId) {
  const email = `sign-in-${label}-${Date.now()}-${Math.random()}@test.local`;
  const created = await owner("POST", "/users", { name: `${label} user`, email, password: "password-123", role, clientId });
  check(`${label}: create ${role}`, created.status === 201, String(created.status));
  const request = session();
  check(`${label}: login`, (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  return request;
}

const outboxLines = async () => (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const tokenOf = (link) => String(link ?? "").split("/site-sign-in/")[1];

function signInBody(briefing, extra = {}) {
  return {
    name: "Sam Sparks", company: "Sparks Electrical Ltd", phone: "07700 900123", email: "SAM@sparks.test",
    visitReason: "PAT testing", briefingVersion: briefing.version,
    fireAcknowledged: true, asbestosAcknowledged: true, declaration: true, signature: SIGNATURE, ...extra,
  };
}

async function main() {
  if (!process.env.FIXTRACK_TEST_EMAIL_OUTBOX) {
    throw new Error("FIXTRACK_TEST_EMAIL_OUTBOX must be set by the self-booting test runner");
  }
  await writeFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "");
  const owner = await tenant("owner");
  const foreign = await tenant("foreign");
  const ownerMe = await owner("GET", "/auth/me");
  const clientId = ownerMe.data?.user?.clientId ?? ownerMe.data?.client?.id;
  const staff = await userSession(owner, "staff", "client_staff", clientId);
  const viewer = await userSession(owner, "viewer", "client_viewer", clientId);

  const site = await owner("POST", "/sites", { name: "Riverside Hotel" });
  check("create site", site.status === 201, `${site.status} ${JSON.stringify(site.data)}`);
  const siteId = site.data?.id;
  const bare = await owner("POST", "/sites", { name: "Bare Lodge" });
  const bareId = bare.data?.id;

  // Before set-up
  let sites = await owner("GET", "/contractor-sign-in/sites");
  let setup = sites.data?.sites?.find((s) => s.siteId === siteId);
  check("sites list shows the site with sign-in off and no link", sites.status === 200 && sites.data?.canManage === true
    && setup?.enabled === false && setup?.link === null && setup?.asbestosStatus === "missing", JSON.stringify(sites.data));
  check("viewer cannot see contractor sign-in", (await viewer("GET", "/contractor-sign-in/sites")).status === 403);
  check("staff can see the sites but not manage", (await staff("GET", "/contractor-sign-in/sites")).data?.canManage === false);
  check("staff cannot turn sign-in on", (await staff("PUT", `/contractor-sign-in/sites/${siteId}`, { enabled: true })).status === 403);
  check("another business cannot set up this site", (await foreign("PUT", `/contractor-sign-in/sites/${siteId}`, { enabled: true })).status === 404);
  check("poster needs sign-in turned on", (await owner("GET", `/contractor-sign-in/sites/${siteId}/poster`)).status === 404);

  // Owner sets it up
  const fireText = "On the alarm, leave by the nearest exit and go to the assembly point in the front car park. Do not use the lift.";
  const put = await owner("PUT", `/contractor-sign-in/sites/${siteId}`, { enabled: true, fireProcedure: fireText });
  check("owner turns sign-in on with a fire procedure", put.status === 200 && put.data?.enabled === true
    && put.data?.fireProcedure === fireText && /\/site-sign-in\/[A-Za-z0-9_-]{32,}$/.test(put.data?.link ?? ""), JSON.stringify(put.data));
  const firstLink = put.data?.link;
  const token = tokenOf(firstLink);
  check("saving again keeps the link", (await owner("PUT", `/contractor-sign-in/sites/${siteId}`, { fireProcedure: fireText })).data?.link === firstLink);
  check("the link cannot be chosen by the caller", (await owner("PUT", `/contractor-sign-in/sites/${siteId}`, { linkToken: "a".repeat(40) })).status === 400);

  // Asbestos register for the site
  const record = await owner("POST", "/registers/asbestos", {
    siteId, builtBefore2000: "yes", surveyType: "management", surveyDate: today, surveyor: "Acme Surveys",
  });
  check("create asbestos record", record.status === 201, `${record.status} ${JSON.stringify(record.data)}`);
  const entry = await owner("POST", `/registers/asbestos/${record.data?.id}/entries`, {
    location: "Boiler room ceiling", material: "Asbestos insulating board", condition: "low_damage",
    priority: "medium", action: "manage", notes: "Internal note: quote for removal pending",
  });
  check("create asbestos entry", entry.status === 201, `${entry.status} ${JSON.stringify(entry.data)}`);

  // The contractor's view
  let briefing = await anonymous("GET", `/site-sign-in/${token}`);
  check("contractor sees the site, fire procedure and asbestos register", briefing.status === 200
    && briefing.data?.siteName === "Riverside Hotel" && briefing.data?.fireProcedure === fireText
    && briefing.data?.asbestos?.status === "register" && briefing.data?.asbestos?.entries?.length === 1
    && briefing.data?.asbestos?.entries?.[0]?.location === "Boiler room ceiling", JSON.stringify(briefing.data));
  check("internal register notes are not shown to contractors", !JSON.stringify(briefing.data).includes("Internal note"));
  check("set the business's own name", (await owner("PUT", "/settings", { companyName: "Riverside Hotels Ltd" })).status === 200);
  check("contractors see the business's own name", (await anonymous("GET", `/site-sign-in/${token}`)).data?.businessName === "Riverside Hotels Ltd");
  check("an unknown link is refused", (await anonymous("GET", `/site-sign-in/${"x".repeat(32)}`)).status === 404);

  // Sign-in rules
  check("all three ticks are required",
    (await anonymous("POST", `/site-sign-in/${token}/sign-in`, signInBody(briefing.data, { asbestosAcknowledged: false }))).status === 400);
  check("a signature is required",
    (await anonymous("POST", `/site-sign-in/${token}/sign-in`, signInBody(briefing.data, { signature: "" }))).status === 400);
  check("name and company are required",
    (await anonymous("POST", `/site-sign-in/${token}/sign-in`, signInBody(briefing.data, { company: " " }))).status === 400);
  check("signing against out-of-date information asks them to read again",
    (await anonymous("POST", `/site-sign-in/${token}/sign-in`, signInBody(briefing.data, { briefingVersion: "stale" }))).status === 409);

  const plumber = await owner("POST", "/contractors", { name: "Sam Sparks", email: "sam@sparks.test" });
  const signedIn = await anonymous("POST", `/site-sign-in/${token}/sign-in`, signInBody(briefing.data));
  check("contractor signs in", signedIn.status === 201 && /^[a-f0-9]{64}$/.test(signedIn.data?.signOutToken ?? ""), JSON.stringify(signedIn.data));
  const signOutToken = signedIn.data?.signOutToken;

  let visits = await owner("GET", `/contractor-sign-in/visits?siteId=${siteId}`);
  const visit = visits.data?.[0];
  check("the visit is listed as on site", visits.status === 200 && visits.data?.length === 1 && visit?.status === "on_site"
    && visit?.name === "Sam Sparks" && visit?.company === "Sparks Electrical Ltd" && visit?.fireAcknowledged === true
    && visit?.asbestosStatus === "register", JSON.stringify(visits.data));
  check("the visit is matched to the contractor by email", visit?.contractorId === plumber.data?.id, JSON.stringify(visit));
  check("the list leaves out signatures", visit && !("signature" in visit));
  sites = await owner("GET", "/contractor-sign-in/sites");
  check("site shows one person on site", sites.data?.sites?.find((s) => s.siteId === siteId)?.onSiteCount === 1);
  const detail = await owner("GET", `/contractor-sign-in/visits/${visit?.id}`);
  check("visit detail keeps what they read and their signature", detail.status === 200 && detail.data?.fireProcedureText === fireText
    && detail.data?.asbestosSnapshot?.entries?.[0]?.material === "Asbestos insulating board" && detail.data?.signature === SIGNATURE,
    JSON.stringify(detail.data).slice(0, 400));
  check("staff can see who is on site", (await staff("GET", `/contractor-sign-in/visits?siteId=${siteId}`)).data?.length === 1);
  check("viewer cannot see visits", (await viewer("GET", "/contractor-sign-in/visits")).status === 403);
  check("another business cannot see visits", (await foreign("GET", `/contractor-sign-in/visits/${visit?.id}`)).status === 404);
  check("another business cannot list this site", (await foreign("GET", `/contractor-sign-in/visits?siteId=${siteId}`)).status === 404);

  // The record keeps what they read after the site changes it
  const newFire = `${fireText} Assembly point moved to the rear lawn.`;
  await owner("PUT", `/contractor-sign-in/sites/${siteId}`, { fireProcedure: newFire });
  check("the visit still holds the procedure they confirmed",
    (await owner("GET", `/contractor-sign-in/visits/${visit?.id}`)).data?.fireProcedureText === fireText);
  check("the old reading is now out of date",
    (await anonymous("POST", `/site-sign-in/${token}/sign-in`, signInBody(briefing.data, { name: "Late reader" }))).status === 409);

  // Sign out from the contractor's phone
  check("their phone can check the visit", (await anonymous("POST", `/site-sign-in/${token}/visit`, { signOutToken })).data?.signedOutAt === null);
  check("a made-up sign-out key is refused", (await anonymous("POST", `/site-sign-in/${token}/sign-out`, { signOutToken: "a".repeat(64) })).status === 404);
  const out = await anonymous("POST", `/site-sign-in/${token}/sign-out`, { signOutToken });
  check("contractor signs out", out.status === 200 && out.data?.signedOutAt, JSON.stringify(out.data));
  visits = await owner("GET", `/contractor-sign-in/visits?siteId=${siteId}`);
  check("the visit shows as signed out", visits.data?.[0]?.status === "signed_out" && visits.data?.[0]?.signedOutByName === null);
  check("signing out twice keeps the first time",
    (await anonymous("POST", `/site-sign-in/${token}/sign-out`, { signOutToken })).data?.signedOutAt === out.data?.signedOutAt);

  // Staff sign someone out (roll call)
  briefing = await anonymous("GET", `/site-sign-in/${token}`);
  const second = await anonymous("POST", `/site-sign-in/${token}/sign-in`, signInBody(briefing.data, { name: "Alex Plaster", email: "", company: "AP Plastering" }));
  check("a second contractor signs in", second.status === 201, JSON.stringify(second.data));
  visits = await owner("GET", `/contractor-sign-in/visits?siteId=${siteId}`);
  const alex = visits.data?.find((v) => v.name === "Alex Plaster");
  check("a contractor with no email is not matched", alex?.contractorId === null && alex?.email === null);
  check("viewer cannot sign anyone out", (await viewer("POST", `/contractor-sign-in/visits/${alex?.id}/sign-out`)).status === 403);
  const staffOut = await staff("POST", `/contractor-sign-in/visits/${alex?.id}/sign-out`);
  check("staff sign a contractor out and are named", staffOut.status === 200 && staffOut.data?.status === "signed_out"
    && staffOut.data?.signedOutByName === "staff user" && !("signature" in (staffOut.data ?? {})), JSON.stringify(staffOut.data));

  // Poster and email
  const poster = await owner("GET", `/contractor-sign-in/sites/${siteId}/poster`, undefined, true);
  check("poster is a PDF", poster.status === 200 && poster.headers.get("content-type")?.includes("application/pdf")
    && poster.bytes.subarray(0, 5).toString() === "%PDF-");
  check("another business cannot print the poster", (await foreign("GET", `/contractor-sign-in/sites/${siteId}/poster`)).status === 404);
  const foreignContractor = await foreign("POST", "/contractors", { name: "Other", email: "other@test.local" });
  check("another business's contractor is refused",
    (await owner("POST", `/contractor-sign-in/sites/${siteId}/email-link`, { contractorId: foreignContractor.data?.id })).status === 400);
  check("staff cannot email the link", (await staff("POST", `/contractor-sign-in/sites/${siteId}/email-link`, { contractorId: plumber.data?.id })).status === 403);
  const emailed = await owner("POST", `/contractor-sign-in/sites/${siteId}/email-link`, { contractorId: plumber.data?.id });
  const sent = await outboxLines();
  check("owner emails the link to a contractor", emailed.status === 200 && sent.length === 1 && sent[0].to === "sam@sparks.test"
    && sent[0].html.includes(token) && sent[0].html.includes("Riverside Hotel"), JSON.stringify(sent));

  // Reset and turn off
  const reset = await owner("POST", `/contractor-sign-in/sites/${siteId}/reset-link`);
  check("reset gives a new link", reset.status === 200 && reset.data?.link && reset.data.link !== firstLink);
  check("the old link stops working", (await anonymous("GET", `/site-sign-in/${token}`)).status === 404);
  check("the old link can no longer sign out", (await anonymous("POST", `/site-sign-in/${token}/sign-out`, { signOutToken })).status === 404);
  const newToken = tokenOf(reset.data?.link);
  check("the new link works", (await anonymous("GET", `/site-sign-in/${newToken}`)).status === 200);
  await owner("PUT", `/contractor-sign-in/sites/${siteId}`, { enabled: false });
  check("a switched-off link stops working", (await anonymous("GET", `/site-sign-in/${newToken}`)).status === 404);
  check("staff cannot reset the link", (await staff("POST", `/contractor-sign-in/sites/${siteId}/reset-link`)).status === 403);

  // A site with nothing set up: contractors can still sign in, and the owner hears about it
  const bareSetup = await owner("PUT", `/contractor-sign-in/sites/${bareId}`, { enabled: true });
  const bareToken = tokenOf(bareSetup.data?.link);
  const bareBriefing = await anonymous("GET", `/site-sign-in/${bareToken}`);
  check("a site with no procedure or register says so", bareBriefing.data?.fireProcedure === null
    && bareBriefing.data?.asbestos?.status === "missing", JSON.stringify(bareBriefing.data));
  check("they can still sign in",
    (await anonymous("POST", `/site-sign-in/${bareToken}/sign-in`, signInBody(bareBriefing.data))).status === 201);
  check("a second sign-in the same day", (await anonymous("POST", `/site-sign-in/${bareToken}/sign-in`, signInBody(bareBriefing.data, { name: "Second" }))).status === 201);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const bell = await owner("GET", "/notifications");
  const notices = bell.data?.notifications?.filter((n) => n.kind === "contractor_sign_in_missing") ?? [];
  check("owner gets one bell notice about the missing information", notices.length === 1
    && notices[0].title.includes("Bare Lodge") && notices[0].title.includes("fire procedure or asbestos register"), JSON.stringify(notices));
  const bareVisit = (await owner("GET", `/contractor-sign-in/visits?siteId=${bareId}`)).data?.[0];
  check("the visit records that there was nothing to read", bareVisit?.fireAcknowledged === false && bareVisit?.asbestosStatus === "missing");

  // Honeypot
  const bot = await anonymous("POST", `/site-sign-in/${bareToken}/sign-in`, signInBody(bareBriefing.data, { name: "Bot", website: "http://spam.test" }));
  check("a form-filler looks signed in but nothing is saved", bot.status === 201
    && !(await owner("GET", `/contractor-sign-in/visits?siteId=${bareId}`)).data?.some((v) => v.name === "Bot"));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
