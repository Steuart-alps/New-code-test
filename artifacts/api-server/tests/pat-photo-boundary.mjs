// PAT test photos stay inside the department/site recorded with their test,
// before and after the appliance is relocated or retired. Runs only through
// tests/run-fresh-schema.sh: photo rows are inserted into its disposable
// database with psql (no object storage, no application data). Upload
// finalisation needs real storage, so its happy path is covered elsewhere;
// here every boundary decision must happen before storage is touched.
import { execFileSync } from "node:child_process";

const BASE = process.env.API_BASE;
const DATABASE_URL = process.env.DATABASE_URL;
if (process.env.FRESH_SCHEMA_TEST !== "1" || !BASE || !DATABASE_URL) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/pat-photo-boundary.mjs (disposable database only)");
}
let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}: ${detail}`); console.error(`FAIL: ${name}: ${detail}`); }
}
const expectStatus = (name, response, expected) => check(name, expected.includes(response.status), `expected ${expected.join("/")}, got ${response.status} ${JSON.stringify(response.data)}`);
function session() {
  let cookie = "";
  const request = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (response.headers.get("content-type") || "").includes("application/json") ? await response.json().catch(() => null) : null;
    return { status: response.status, data };
  };
  return request;
}
const sqlValue = (statement) => execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-Atc", statement], { encoding: "utf8" }).trim().split("\n")[0];
const int = (value) => { if (!Number.isInteger(value)) throw new Error(`Expected integer, got ${value}`); return value; };
const insertPhoto = (clientId, testId, objectPath) => Number(sqlValue(
  `INSERT INTO check_photos (client_id, entity_type, entity_id, object_path) VALUES (${int(clientId)}, 'pat_test', ${int(testId)}, '${objectPath.replace(/[^a-zA-Z0-9/_.-]/g, "")}') RETURNING id`,
));
const photoCount = (where) => Number(sqlValue(`SELECT count(*) FROM check_photos WHERE ${where}`));

async function registerTenant(label, stamp) {
  const user = session(), email = `pat-photo-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `PAT photo ${label}`, email, password: "password-123" });
  expectStatus(`register ${label}`, registered, [200, 201]);
  expectStatus(`verify ${label}`, await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
  expectStatus(`login ${label}`, await user("POST", "/auth/login", { email, password: "password-123" }), [200]);
  const me = await user("GET", "/auth/me");
  return { user, clientId: (me.data?.user ?? me.data)?.clientId };
}

async function main() {
  const stamp = Date.now(), today = new Date().toISOString().slice(0, 10);
  const { user: admin, clientId } = await registerTenant("admin", stamp);
  const alphaDept = await admin("POST", "/departments", { name: `Photo Alpha ${stamp}` });
  const betaDept = await admin("POST", "/departments", { name: `Photo Beta ${stamp}` });
  const alphaSite = await admin("POST", "/sites", { name: `Photo Alpha ${stamp}`, departmentId: alphaDept.data.id, seedStarterChecks: false });
  const betaSite = await admin("POST", "/sites", { name: `Photo Beta ${stamp}`, departmentId: betaDept.data.id, seedStarterChecks: false });
  const staffFor = async (label, departmentId) => {
    const email = `pat-photo-${label}-staff-${stamp}@test.local`;
    expectStatus(`create ${label} staff`, await admin("POST", "/users", {
      name: `${label} staff`, email, password: "password-456", role: "client_staff", clientId, departmentId,
    }), [200, 201]);
    const staff = session();
    expectStatus(`login ${label} staff`, await staff("POST", "/auth/login", { email, password: "password-456" }), [200]);
    return staff;
  };
  const alpha = await staffFor("alpha", alphaDept.data.id), beta = await staffFor("beta", betaDept.data.id);
  const { user: foreign } = await registerTenant("foreign", stamp);

  const appliance = await admin("POST", "/pat-track/appliances", { siteId: alphaSite.data.id, name: "Photo kettle", location: "Alpha store" });
  const betaAppliance = await admin("POST", "/pat-track/appliances", { siteId: betaSite.data.id, name: "Beta lamp" });
  const alphaTest = await alpha("POST", "/pat-track/tests", { applianceId: appliance.data.id, testDate: today, result: "fail" });
  const betaTest = await beta("POST", "/pat-track/tests", { applianceId: betaAppliance.data.id, testDate: today, result: "pass" });
  for (const [name, response] of [["alpha appliance", appliance], ["beta appliance", betaAppliance], ["alpha test", alphaTest], ["beta test", betaTest]]) {
    expectStatus(`create ${name}`, response, [201]);
  }
  const alphaPath = `/objects/finalized/tenant-${clientId}/pat-photo-alpha-${stamp}.jpg`;
  const betaPath = `/objects/finalized/tenant-${clientId}/pat-photo-beta-${stamp}.jpg`;
  const alphaPhoto = insertPhoto(clientId, alphaTest.data.id, alphaPath);
  insertPhoto(clientId, betaTest.data.id, betaPath);
  const list = (who, testId) => who("GET", `/photos?entityType=pat_test&entityId=${testId}`);
  const download = (who, path) => who("GET", `/storage${path}`);

  const boundary = async (phase) => {
    const own = await list(alpha, alphaTest.data.id);
    expectStatus(`${phase}: recording department lists its test photo`, own, [200]);
    check(`${phase}: recording department sees photo`, own.data?.some?.(p => p.id === alphaPhoto));
    expectStatus(`${phase}: other department cannot list photo metadata`, await list(beta, alphaTest.data.id), [404]);
    expectStatus(`${phase}: foreign tenant cannot list photo metadata`, await list(foreign, alphaTest.data.id), [404]);
    expectStatus(`${phase}: admin can list photo metadata`, await list(admin, alphaTest.data.id), [200]);
    expectStatus(`${phase}: other department cannot request upload`, await beta("POST", "/photos/request-upload", {
      entityType: "pat_test", entityId: alphaTest.data.id, name: "x.jpg", contentType: "image/jpeg",
    }), [404]);
    expectStatus(`${phase}: other department cannot attach photo`, await beta("POST", "/photos", {
      entityType: "pat_test", entityId: alphaTest.data.id, objectPath: `/objects/uploads/tenant-${clientId}/staged.jpg`,
    }), [404]);
    expectStatus(`${phase}: foreign tenant cannot attach photo`, await foreign("POST", "/photos", {
      entityType: "pat_test", entityId: alphaTest.data.id, objectPath: `/objects/uploads/tenant-${clientId}/staged.jpg`,
    }), [404]);
    expectStatus(`${phase}: other department cannot delete photo`, await beta("DELETE", `/photos/${alphaPhoto}`), [404]);
    check(`${phase}: refused delete keeps photo`, photoCount(`id=${alphaPhoto}`) === 1);
    expectStatus(`${phase}: other department cannot download by object path`, await download(beta, alphaPath), [403]);
    expectStatus(`${phase}: foreign tenant cannot download by object path`, await download(foreign, alphaPath), [403]);
    const ownDownload = await download(alpha, alphaPath);
    check(`${phase}: recording department passes the department check`, ownDownload.status !== 403, `status ${ownDownload.status}`);
  };

  await boundary("before relocation");
  const ownUpload = await alpha("POST", "/photos/request-upload", {
    entityType: "pat_test", entityId: alphaTest.data.id, name: "x.jpg", contentType: "image/jpeg",
  });
  check("recording department passes the parent check for uploads", ownUpload.status !== 404 && ownUpload.status !== 403, `status ${ownUpload.status}`);
  // A path from another department's photo cannot be re-attached to gain access.
  const beforeCopies = photoCount(`client_id=${clientId}`);
  expectStatus("finalized object path of another department cannot be copied onto a record", await alpha("POST", "/photos", {
    entityType: "pat_test", entityId: alphaTest.data.id, objectPath: betaPath,
  }), [403]);
  check("refused copy creates no photo row", photoCount(`client_id=${clientId}`) === beforeCopies);
  // A finalized object has one photo row per tenant (unique client/object
  // path), so another PAT test or module photo cannot re-reference it and
  // inherit a different department's access.
  for (const [label, entity] of [["another department's test", `'pat_test', ${int(betaTest.data.id)}`], ["another module", "'incident', 1"]]) {
    let rejected = false;
    try {
      sqlValue(`INSERT INTO check_photos (client_id, entity_type, entity_id, object_path) VALUES (${int(clientId)}, ${entity}, '${alphaPath}') RETURNING id`);
    } catch { rejected = true; }
    check(`a copied photo reference cannot be recorded under ${label}`, rejected);
  }
  expectStatus("the original department's object stays closed to the other department", await download(beta, alphaPath), [403]);

  expectStatus("relocate appliance to beta", await admin("PUT", `/pat-track/appliances/${appliance.data.id}`, {
    siteId: betaSite.data.id, name: "Photo kettle", location: "Beta store",
  }), [200]);
  await boundary("after relocation");
  const destinationTest = await beta("POST", "/pat-track/tests", { applianceId: appliance.data.id, testDate: today, result: "pass" });
  expectStatus("destination records a new test", destinationTest, [201]);
  const destinationPath = `/objects/finalized/tenant-${clientId}/pat-photo-destination-${stamp}.jpg`;
  const destinationPhoto = insertPhoto(clientId, destinationTest.data.id, destinationPath);
  check("destination department lists its own new test photo", (await list(beta, destinationTest.data.id)).data?.some?.(p => p.id === destinationPhoto));
  expectStatus("source department cannot list destination photo", await list(alpha, destinationTest.data.id), [404]);
  expectStatus("source department cannot download destination photo", await download(alpha, destinationPath), [403]);

  expectStatus("retire appliance", await admin("DELETE", `/pat-track/appliances/${appliance.data.id}`), [200]);
  await boundary("after retirement");
  check("destination photo survives retirement", (await list(beta, destinationTest.data.id)).data?.some?.(p => p.id === destinationPhoto));

  expectStatus("recording department may delete its retained photo", await alpha("DELETE", `/photos/${alphaPhoto}`), [200]);
  check("authorized delete removes the row", photoCount(`id=${alphaPhoto}`) === 0);
  expectStatus("foreign tenant cannot delete another tenant's photo", await foreign("DELETE", `/photos/${destinationPhoto}`), [404]);

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}
main().catch((error) => { console.error(error); process.exit(1); });
