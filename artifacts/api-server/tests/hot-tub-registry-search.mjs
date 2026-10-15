// Hot tub registry search: GET /hot-tub/tubs?search= matches tub or site
// names, combines with ?active= and stays department-scoped.
// Run with the API server and database available: node tests/hot-tub-registry-search.mjs
const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { if (ok) passed++; else { failed++; console.error(`FAIL ${name}`, detail); } };
const client = () => {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get("set-cookie"); if (c) cookie = c.split(";")[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
};
const names = response => (Array.isArray(response.data) ? response.data.map(t => t.name).sort() : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());

const run = async () => {
  const ts = Date.now();
  const admin = client();
  const email = `tub-search-${ts}@test.local`;
  const reg = await admin("POST", "/auth/register", { name: "Tub Search Admin", email, password: "password-123" });
  check("register", [200, 201].includes(reg.status), reg.status);
  if (reg.data?.verificationToken) await admin("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
  const login = await admin("POST", "/auth/login", { email, password: "password-123" });
  check("login", login.status === 200, login.status);
  if (login.status !== 200) return;
  const me = await admin("GET", "/auth/me");
  const clientId = (me.data?.user ?? me.data)?.clientId;

  const alphaDept = await admin("POST", "/departments", { name: "Spa Alpha" });
  const betaDept = await admin("POST", "/departments", { name: "Spa Beta" });
  check("departments created", [alphaDept, betaDept].every(r => [200, 201].includes(r.status)));
  const alphaSite = await admin("POST", "/sites", { name: "Alpha Lodge", departmentId: alphaDept.data?.id, seedStarterChecks: false });
  const betaSite = await admin("POST", "/sites", { name: "Beta Lodge", departmentId: betaDept.data?.id, seedStarterChecks: false });
  check("sites created", alphaSite.status === 201 && betaSite.status === 201, `${alphaSite.status} ${betaSite.status}`);

  const addTub = async (body) => {
    const r = await admin("POST", "/hot-tub/tubs", body);
    check(`add tub ${body.name}`, r.status === 201, r.status);
    return r.data?.id;
  };
  const mainSpaId = await addTub({ name: "Main Spa", siteId: alphaSite.data?.id });
  const gardenTubId = await addTub({ name: "Garden Tub", siteId: alphaSite.data?.id, active: false });
  await addTub({ name: "Spa 50%_Off", siteId: null });
  await addTub({ name: "Beta Spa", siteId: betaSite.data?.id });
  await addTub({ name: "Roof Tub", siteId: betaSite.data?.id, active: false });

  const list = (who, query) => who("GET", `/hot-tub/tubs${query ? `?${query}` : ""}`);
  check("no search lists every tub", same(names(await list(admin)), ["Main Spa", "Garden Tub", "Spa 50%_Off", "Beta Spa", "Roof Tub"]));
  check("blank search lists every tub", names(await list(admin, "search=%20%20"))?.length === 5);
  check("search matches tub name, any case", same(names(await list(admin, "search=SPA")), ["Main Spa", "Spa 50%_Off", "Beta Spa"]));
  check("search matches part of a name with spaces trimmed", same(names(await list(admin, "search=%20main%20")), ["Main Spa"]));
  check("search matches site name", same(names(await list(admin, "search=alpha%20lodge")), ["Main Spa", "Garden Tub"]));
  check("search + active=true", same(names(await list(admin, "search=lodge&active=true")), ["Main Spa", "Beta Spa"]));
  check("search + active=false", same(names(await list(admin, "search=lodge&active=false")), ["Garden Tub", "Roof Tub"]));
  check("% is matched literally", same(names(await list(admin, "search=%25")), ["Spa 50%_Off"]));
  check("_ is matched literally", same(names(await list(admin, "search=_")), ["Spa 50%_Off"]));
  check("no match returns an empty list", same(names(await list(admin, "search=jacuzzi")), []));
  check("over-long search rejected", (await list(admin, `search=${"a".repeat(201)}`)).status === 400);
  check("repeated search param rejected", (await list(admin, "search=a&search=b")).status === 400);
  check("bad active filter still rejected", (await list(admin, "search=spa&active=maybe")).status === 400);

  // Department scoping: Alpha staff never see Beta tubs, whatever they search.
  const staffEmail = `tub-search-staff-${ts}@test.local`;
  const staffUser = await admin("POST", "/users", {
    name: "Alpha Staff", email: staffEmail, password: "password-456", role: "client_staff", clientId, departmentId: alphaDept.data?.id,
  });
  check("staff created", [200, 201].includes(staffUser.status), staffUser.status);
  const staff = client();
  check("staff login", (await staff("POST", "/auth/login", { email: staffEmail, password: "password-456" })).status === 200);
  check("staff search sees own department and unassigned tubs only", same(names(await list(staff, "search=spa")), ["Main Spa", "Spa 50%_Off"]));
  check("staff cannot find another department's tubs by site name", same(names(await list(staff, "search=beta")), []));
  check("staff search + inactive filter", same(names(await list(staff, "search=tub&active=false")), ["Garden Tub"]));

  // Toggling and deleting are reflected in searched results.
  const toggled = await admin("PUT", `/hot-tub/tubs/${mainSpaId}`, { active: false });
  check("toggle tub inactive", toggled.status === 200, toggled.status);
  check("toggled tub leaves the active search", same(names(await list(admin, "search=main&active=true")), []));
  check("toggled tub joins the inactive search", same(names(await list(admin, "search=main&active=false")), ["Main Spa"]));
  const deleted = await admin("DELETE", `/hot-tub/tubs/${gardenTubId}`);
  check("delete tub", [200, 204].includes(deleted.status), deleted.status);
  check("deleted tub no longer found", same(names(await list(admin, "search=garden")), []));

  console.log(`Hot tub registry search: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
};
run().catch(error => { console.error(error); process.exitCode = 1; });
