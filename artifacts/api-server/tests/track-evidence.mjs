// Shared inspection evidence coverage for every module.
const BASE = process.env.API_BASE || "http://localhost:8080/api";
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
async function register(req, suffix) {
  const email = `track-evidence-${suffix}-${Date.now()}@test.local`;
  const registered = await req("POST", "/auth/register", { name: `Evidence ${suffix}`, email, password: "password-123" });
  status(`${suffix} registers`, registered, [200, 201]);
  if (registered.data?.verificationToken) {
    status(`${suffix} verifies`, await req("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
    status(`${suffix} logs in`, await req("POST", "/auth/login", { email, password: "password-123" }), [200, 201]);
  }
  return req("GET", "/auth/me");
}
async function main() {
  const admin = session();
  const me = await register(admin, "owner");
  check("owner has client", Number.isInteger((me.data?.user ?? me.data)?.clientId));
  const modules = ["fire", "legionella", "green", "pat", "room"];
  for (const module of modules) {
    const created = await admin("POST", "/track-evidence", {
      module,
      evidenceType: "observation",
      title: `${module} inspection observation`,
      details: "Recorded during the operational inspection.",
    });
    status(`create ${module} evidence`, created, [201]);
    check(`${module} records authenticated recorder`, created.data?.recordedByName === "Evidence owner");
    const listed = await admin("GET", `/track-evidence?module=${module}`);
    status(`list ${module} evidence`, listed, [200]);
    check(`${module} evidence is listed`, (listed.data || []).some(item => item.id === created.data?.id));
    status(`${module} rejects self-review`, await admin("POST", `/track-evidence/${created.data?.id}/review`, { status: "verified", reviewNotes: "Reviewed" }), [400]);
  }
  const other = session();
  await register(other, "other");
  const fire = await admin("GET", "/track-evidence?module=fire");
  const foreignId = fire.data?.[0]?.id;
  status("other tenant cannot see owner evidence", await other("GET", "/track-evidence?module=fire"), [200]);
  const otherEvidence = await other("GET", "/track-evidence?module=fire");
  check("other tenant receives no owner evidence", Array.isArray(otherEvidence.data) && !otherEvidence.data.some(item => item.id === foreignId));
  status("other tenant cannot review owner evidence", await other("POST", `/track-evidence/${foreignId}/review`, { status: "verified", reviewNotes: "No access" }), [404]);
  console.log(`track-evidence tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });