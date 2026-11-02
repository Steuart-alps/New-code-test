import assert from "node:assert/strict";
import { clearOutbox, createTenant, createUser, pool, readOutbox, requestSession } from "./approval-workflow-fixtures.mjs";

// A contractor logs PATrack tests through a link: a manager sets up the visit
// and emails the link; the contractor signs in at the site through it (fire
// procedure, asbestos register, signature), and only then logs a pass or fail
// for each appliance. Results land on PATrack as tests, a fail raises its
// action the same day, and sign-off records the certificate with each failed
// appliance. The link belongs to one visit at one site of one business.
// Usage: pnpm --filter @workspace/api-server run test:contractor-tests (boots its own API and database).
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const anonymous = requestSession();
const tokenOf = (link) => String(link ?? "").split("/contractor-tests/")[1];
const today = new Date().toISOString().slice(0, 10);
const dayOffset = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const signInBody = (briefing, extra = {}) => ({
  name: "Sam Sparks", company: "Sparks Electrical Ltd", phone: "07700 900123", email: "",
  briefingVersion: briefing.version, fireAcknowledged: true, asbestosAcknowledged: true, declaration: true, signature: SIGNATURE, ...extra,
});
const signOffBody = (extra = {}) => ({
  certificateRef: "SE-2026-114", name: "Sam Sparks", company: "Sparks Electrical Ltd", declaration: true, signature: SIGNATURE, ...extra,
});
const rows = async (text, values) => (await pool.query(text, values)).rows;

try {
  const owner = await createTenant("contractor-tests");
  const foreign = await createTenant("contractor-tests-foreign");
  const staff = await createUser(owner, { role: "client_staff" });
  const viewer = await createUser(owner, { role: "client_viewer" });

  const site = await owner.request("POST", "/sites", { name: "Riverside Hotel", seedStarterChecks: false });
  assert.equal(site.status, 201, JSON.stringify(site.data));
  const siteId = site.data.id;
  const foreignSite = await foreign.request("POST", "/sites", { name: "Elsewhere", seedStarterChecks: false });
  const kitchen = await owner.request("POST", "/pat-track/rooms", { siteId, name: "Kitchen" });
  assert.equal(kitchen.status, 201, JSON.stringify(kitchen.data));
  const appliance = async (request, body) => {
    const created = await request("POST", "/pat-track/appliances", body);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data.id;
  };
  const kettle = await appliance(owner.request, { name: "Kettle", siteId, location: "Kitchen", applianceType: "Kitchen Appliance" });
  const toaster = await appliance(owner.request, { name: "Toaster", siteId, location: "Kitchen", applianceType: "Kitchen Appliance" });
  const hoover = await appliance(owner.request, { name: "Hoover", siteId, location: "Store" });
  const foreignKettle = await appliance(foreign.request, { name: "Their kettle", siteId: foreignSite.data.id });
  const contractor = await owner.request("POST", "/contractors", { name: "Sam Sparks", company: "Sparks Electrical Ltd", email: "sam@sparks.test" });
  assert.equal(contractor.status, 201, JSON.stringify(contractor.data));

  // Setting up the visit
  const visitBody = { siteId, contractorId: contractor.data.id, startsOn: today, endsOn: today };
  assert.equal((await staff.request("POST", "/pat-track/contractor-visits", visitBody)).status, 403, "staff cannot set up a visit");
  assert.equal((await viewer.request("GET", "/pat-track/contractor-visits")).status, 403, "viewers see nothing");
  assert.equal((await foreign.request("POST", "/pat-track/contractor-visits", visitBody)).status, 404, "another business's site");
  assert.equal((await owner.request("POST", "/pat-track/contractor-visits", { ...visitBody, startsOn: dayOffset(1) })).status, 400, "ends before it starts");
  assert.equal((await owner.request("POST", "/pat-track/contractor-visits", { siteId, contractorName: "Walk-in Electrical", startsOn: today, endsOn: today })).status, 400,
    "emailing needs an address");
  assert.equal((await owner.request("POST", "/pat-track/contractor-visits", { ...visitBody, contractorId: null })).status, 400, "needs a contractor");

  await clearOutbox();
  const created = await owner.request("POST", "/pat-track/contractor-visits", visitBody);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.match(created.data.link, /\/contractor-tests\/[a-f0-9]{64}$/);
  assert.equal(created.data.emailedTo, "sam@sparks.test");
  assert.equal(created.data.visit.contractorName, "Sparks Electrical Ltd");
  assert.equal(created.data.visit.status, "open");
  const token = tokenOf(created.data.link);
  const visitId = created.data.visit.id;
  const [email] = await readOutbox();
  assert.equal(email?.to, "sam@sparks.test");
  assert.ok(email.html.includes(token) && email.html.includes("Riverside Hotel"), "the email carries the link");
  assert.equal((await rows("SELECT link_token_hash FROM contractor_test_visits WHERE id = $1", [visitId]))[0].link_token_hash.includes(token), false,
    "only a digest of the link is kept");

  // The link before sign-in
  const page = await anonymous("GET", `/contractor-tests/${token}`);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.equal(page.data.siteName, "Riverside Hotel");
  assert.equal(page.data.retestMonths, 12);
  assert.equal(page.data.asbestos.status, "missing");
  assert.equal((await anonymous("GET", `/contractor-tests/${"0".repeat(64)}`)).status, 404, "unknown link");
  assert.equal((await anonymous("GET", `/contractor-tests/${token}/items`)).status, 401, "logging needs a sign-in");
  assert.equal((await anonymous("PUT", `/contractor-tests/${token}/items/${kettle}/result`, { result: "pass" })).status, 401);

  // Signing in through the link
  assert.equal((await anonymous("POST", `/contractor-tests/${token}/sign-in`, signInBody(page.data, { briefingVersion: "stale" }))).status, 409);
  assert.equal((await anonymous("POST", `/contractor-tests/${token}/sign-in`, signInBody(page.data, { declaration: false }))).status, 400);
  const signedIn = await anonymous("POST", `/contractor-tests/${token}/sign-in`, signInBody(page.data));
  assert.equal(signedIn.status, 201, JSON.stringify(signedIn.data));
  const key = { "x-contractor-sign-in": signedIn.data.signOutToken };
  const [signInRow] = await rows("SELECT contractor_test_visit_id, contractor_id, visit_reason, site_id FROM contractor_sign_ins WHERE client_id = $1", [owner.clientId]);
  assert.deepEqual(signInRow, { contractor_test_visit_id: visitId, contractor_id: contractor.data.id, visit_reason: "PAT testing", site_id: siteId },
    "the sign-in is on the site's records, linked to the visit");
  const session = await anonymous("POST", `/contractor-tests/${token}/session`, { signOutToken: signedIn.data.signOutToken });
  assert.equal(session.data?.onSite, true, JSON.stringify(session.data));

  const items = await anonymous("GET", `/contractor-tests/${token}/items`, undefined, "json", key);
  assert.equal(items.status, 200, JSON.stringify(items.data));
  assert.deepEqual(items.data.items.map((item) => item.name), ["Kettle", "Toaster", "Hoover"], "the site's appliances, by location");
  assert.deepEqual(items.data.locations, ["Kitchen", "Store"]);

  // Logging results
  const log = (id, body) => anonymous("PUT", `/contractor-tests/${token}/items/${id}/result`, body, "json", key);
  const pass = await log(kettle, { result: "pass", earthContinuityOhms: "0.08", insulationMohms: ">299" });
  assert.equal(pass.status, 200, JSON.stringify(pass.data));
  assert.equal(pass.data.result, "pass");
  assert.match(pass.data.testedBy, /^Sam Sparks \(Sparks Electrical Ltd\) via contractor link$/);
  const [kettleTest] = await rows("SELECT next_test_date::text AS next, test_date::text AS day, created_by FROM pat_tests WHERE appliance_id = $1", [kettle]);
  assert.equal(kettleTest.next.slice(5), kettleTest.day.slice(5), "next test a year on");
  assert.equal(kettleTest.created_by, null);

  const fail = await log(toaster, { result: "fail", visualInspection: "fail", notes: "Cracked plug" });
  assert.equal(fail.status, 200, JSON.stringify(fail.data));
  const actionFor = async (applianceId) => (await rows(`
    SELECT a.title, a.status, a.site_id, a.instruction, a.resolution_notes FROM track_actions a
    JOIN pat_tests t ON t.id = a.source_record_id AND a.source_kind = 'pat_tests'
    WHERE t.appliance_id = $1`, [applianceId]))[0];
  let action = await actionFor(toaster);
  assert.equal(action?.title, "PAT fail: Toaster (Kitchen)");
  assert.equal(action.status, "open");
  assert.equal(action.site_id, siteId);
  assert.match(action.instruction, /Cracked plug/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bell = await owner.request("GET", "/notifications");
  assert.equal(bell.data?.notifications?.filter((n) => n.kind === "contractor_test_failed").length, 1, JSON.stringify(bell.data));

  // A fail changed to a pass leaves the action for the business to check and close
  assert.equal((await log(toaster, { result: "pass" })).status, 200);
  action = await actionFor(toaster);
  assert.equal(action.status, "open");
  assert.match(action.instruction, /changed to a pass/);
  assert.equal((await log(toaster, { result: "fail", notes: "Cracked plug" })).status, 200);
  action = await actionFor(toaster);
  assert.match(action.instruction, /Cracked plug/);
  assert.equal((await rows("SELECT count(*)::int AS n FROM pat_tests WHERE appliance_id = $1", [toaster]))[0].n, 1, "one test per appliance per visit");

  assert.equal((await log(foreignKettle, { result: "pass" })).status, 404, "another business's appliance");
  assert.equal((await log(hoover, { result: "maybe" })).status, 400);

  const added = await anonymous("POST", `/contractor-tests/${token}/items`, { name: "Microwave", location: "Kitchen", applianceType: "Kitchen Appliance" }, "json", key);
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const [newAppliance] = await rows("SELECT site_id, client_id, active FROM pat_appliances WHERE id = $1", [added.data.id]);
  assert.deepEqual(newAppliance, { site_id: siteId, client_id: owner.clientId, active: true });
  assert.equal((await log(added.data.id, { result: "fail" })).status, 200);

  // Managers follow the visit
  const list = await owner.request("GET", "/pat-track/contractor-visits");
  const listed = list.data?.visits?.find((visit) => visit.id === visitId);
  assert.equal(list.data?.canManage, true);
  assert.deepEqual([listed?.tested, listed?.passed, listed?.failed, listed?.onSiteNow], [3, 1, 2, 1], JSON.stringify(listed));
  const staffList = await staff.request("GET", "/pat-track/contractor-visits");
  assert.equal(staffList.data?.canManage, false, "staff can follow but not manage");
  assert.equal((await foreign.request("GET", `/pat-track/contractor-visits/${visitId}`)).status, 404);
  const detail = await owner.request("GET", `/pat-track/contractor-visits/${visitId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.results.length, 3);
  assert.equal(detail.data.results[0].result, "fail", "fails first");
  assert.equal(detail.data.signIns[0].name, "Sam Sparks");

  // A file that isn't a certificate is refused
  const junk = await anonymous("POST", `/contractor-tests/${token}/certificate`, { fileName: "cert.pdf", mimeType: "application/pdf", data: Buffer.from("not a pdf").toString("base64") });
  assert.equal(junk.status, 400, JSON.stringify(junk.data));

  // Signing off
  assert.equal((await anonymous("POST", `/contractor-tests/${token}/sign-off`, signOffBody())).status, 401, "sign-off needs the sign-in");
  assert.equal((await anonymous("POST", `/contractor-tests/${token}/sign-off`, signOffBody({ declaration: false }), "json", key)).status, 400);
  const signedOff = await anonymous("POST", `/contractor-tests/${token}/sign-off`, signOffBody({ notes: "Two kitchen items failed" }), "json", key);
  assert.equal(signedOff.status, 200, JSON.stringify(signedOff.data));
  assert.deepEqual([signedOff.data.tested, signedOff.data.passed, signedOff.data.failed], [3, 1, 2]);
  const [certificate] = await rows("SELECT * FROM pat_certificates WHERE client_id = $1", [owner.clientId]);
  assert.equal(certificate.certificate_ref, "SE-2026-114");
  assert.equal(certificate.contractor_id, contractor.data.id);
  assert.deepEqual([certificate.appliances_tested_count, certificate.pass_count, certificate.fail_count], [3, 1, 2]);
  assert.match(certificate.notes, /via contractor link/);
  assert.deepEqual((await rows("SELECT room_id FROM pat_certificate_rooms WHERE certificate_id = $1", [certificate.id])).map((r) => r.room_id), [kitchen.data.id],
    "the rooms tested are covered");
  const failures = await rows("SELECT appliance_name, room_id, location_text FROM pat_failures WHERE certificate_id = $1 ORDER BY appliance_name", [certificate.id]);
  assert.deepEqual(failures, [
    { appliance_name: "Microwave", room_id: kitchen.data.id, location_text: "Kitchen" },
    { appliance_name: "Toaster", room_id: kitchen.data.id, location_text: "Kitchen" },
  ]);
  const [visitRow] = await rows("SELECT status, pat_certificate_id, signed_off_name FROM contractor_test_visits WHERE id = $1", [visitId]);
  assert.deepEqual(visitRow, { status: "signed_off", pat_certificate_id: certificate.id, signed_off_name: "Sam Sparks" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bellAfter = await owner.request("GET", "/notifications");
  assert.equal(bellAfter.data?.notifications?.filter((n) => n.kind === "contractor_test_signed_off").length, 1);

  // After sign-off the link only shows the summary and takes the certificate
  assert.equal((await log(kettle, { result: "fail" })).status, 404, "no more testing");
  assert.equal((await anonymous("POST", `/contractor-tests/${token}/sign-off`, signOffBody(), "json", key)).status, 404);
  const after = await anonymous("GET", `/contractor-tests/${token}`);
  assert.equal(after.data?.status, "signed_off");
  assert.equal(after.data?.signedOff?.certificateRef, "SE-2026-114");
  const out = await anonymous("POST", `/contractor-tests/${token}/sign-out`, { signOutToken: signedIn.data.signOutToken });
  assert.ok(out.data?.signedOutAt, JSON.stringify(out.data));
  assert.equal((await owner.request("POST", `/pat-track/contractor-visits/${visitId}/new-link`, {})).status, 409);
  assert.equal((await owner.request("POST", `/pat-track/contractor-visits/${visitId}/end`)).status, 409);

  // A second visit: new link, ending early, expiry
  const second = await owner.request("POST", "/pat-track/contractor-visits", { ...visitBody, sendEmail: false });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(second.data.emailedTo, null);
  const firstToken = tokenOf(second.data.link);
  assert.equal((await staff.request("POST", `/pat-track/contractor-visits/${second.data.visit.id}/new-link`, {})).status, 403);
  const renewed = await owner.request("POST", `/pat-track/contractor-visits/${second.data.visit.id}/new-link`, { sendEmail: false });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.data));
  const secondToken = tokenOf(renewed.data.link);
  assert.equal((await anonymous("GET", `/contractor-tests/${firstToken}`)).status, 404, "the old link stops");
  assert.equal((await anonymous("GET", `/contractor-tests/${secondToken}`)).status, 200);
  await pool.query("UPDATE contractor_test_visits SET expires_at = now() - interval '1 minute' WHERE id = $1", [second.data.visit.id]);
  assert.equal((await anonymous("GET", `/contractor-tests/${secondToken}`)).status, 404, "an expired link stops");
  assert.equal((await owner.request("GET", "/pat-track/contractor-visits")).data.visits.find((v) => v.id === second.data.visit.id)?.status, "expired");
  await pool.query("UPDATE contractor_test_visits SET expires_at = now() + interval '1 day' WHERE id = $1", [second.data.visit.id]);
  const ended = await owner.request("POST", `/pat-track/contractor-visits/${second.data.visit.id}/end`);
  assert.equal(ended.data?.status, "ended", JSON.stringify(ended.data));
  assert.equal((await anonymous("GET", `/contractor-tests/${secondToken}`)).status, 404, "an ended visit's link stops");

  console.log("Contractor test logging: set-up and email, sign-in first, pass/fail onto PATrack with same-day actions, sign-off with certificate and failures, link limits.");
} finally {
  await pool.end();
}
