// Focused Task 84 staff PIN/kiosk integration coverage.
const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => ok ? passed++ : failures.push(`${name}: ${detail}`);

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = response.headers.get("content-type")?.includes("json")
      ? await response.json().catch(() => null) : null;
    return { status: response.status, data };
  };
}
const ok = (name, result, statuses = [200, 201]) => check(name, statuses.includes(result.status), `got ${result.status}`);

async function main() {
  const admin = session();
  const unique = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const registered = await admin("POST", "/auth/register", {
    name: "Staff PIN Test", email: `staff-pin-${unique}@test.local`, password: "password-123",
  });
  ok("register", registered);
  const verified = await admin("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data?.verificationToken || "")}`);
  ok("verify email", verified);
  const loggedIn = await admin("POST", "/auth/login", { email: `staff-pin-${unique}@test.local`, password: "password-123" });
  ok("login", loggedIn);
  const me = await admin("GET", "/auth/me");
  const clientId = me.data?.user?.clientId ?? me.data?.clientId;
  check("tenant context", Number.isInteger(clientId), JSON.stringify(me.data));

  const staffUserEmail = `staff-user-${unique}@test.local`;
  const viewerEmail = `viewer-${unique}@test.local`;
  const createdStaff = await admin("POST", "/users", { name: "Roster Staff", email: staffUserEmail, password: "password-123", role: "client_staff", clientId });
  const createdViewer = await admin("POST", "/users", { name: "Roster Viewer", email: viewerEmail, password: "password-123", role: "client_viewer", clientId });
  ok("create client staff user", createdStaff, [200, 201]);
  ok("create client viewer user", createdViewer, [200, 201]);

  const roster = await admin("POST", "/staff-roster", { name: "PIN Worker", active: true });
  ok("manager create roster", roster, [201]);
  const rosterId = roster.data?.id;
  const raceSetupMember = await admin("POST", "/staff", { name: "Race Setup Worker" });
  const raceSetupId = raceSetupMember.data?.id;
  const raceSetupRequests = await Promise.all([1, 2].map(() => fetch(`${BASE}/staff/${raceSetupId}/set-pin`, {
    method: "POST", headers: { "content-type": "application/json", "x-kiosk-token": "invalid-token" },
    body: JSON.stringify({ pin: "1357" }),
  })));
  // Invalid token requests should both be denied; the actual race is exercised
  // below with the manager-authenticated first-use path.
  check("invalid setup token denied", raceSetupRequests.every(r => r.status === 401), raceSetupRequests.map(r => r.status).join(","));
  const invalidRateLimit = [];
  for (let i = 0; i < 4; i++) {
    invalidRateLimit.push(await fetch(`${BASE}/staff/${raceSetupId}/set-pin`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "1357", enrollment_token: "invalid-token" }),
    }));
  }
  check("invalid enrollment attempts are rate limited",
    invalidRateLimit.at(-1)?.status === 429,
    invalidRateLimit.map(r => r.status).join(","));
  const listed = await admin("GET", "/staff");
  ok("manager list staff", listed);
  check("list has no hash", listed.data?.every(row => !("pin_hash" in row)), JSON.stringify(listed.data));

  for (const [label, email] of [["viewer", viewerEmail], ["staff", staffUserEmail]]) {
    const s = session();
    const login = await s("POST", "/auth/login", { email, password: "password-123" });
    ok(`${label} login`, login);
    const denied = await s("POST", "/staff-roster", { name: `${label} must not mutate` });
    check(`${label} roster mutation denied`, [401, 403].includes(denied.status), `got ${denied.status}`);
    const setupDenied = await s("POST", `/staff/${rosterId}/set-pin`, { pin: "2468" });
    check(`${label} set-pin denied`, [401, 403].includes(setupDenied.status), `got ${setupDenied.status}`);
  }

  const issued = await admin("POST", "/staff/kiosk-token");
  ok("issue kiosk token", issued);
  const token = issued.data?.kiosk_token;
  const rotated = await admin("POST", "/staff/kiosk-token");
  ok("rotate kiosk token", rotated);
  const oldList = await fetch(`${BASE}/staff/public`, { headers: { "x-kiosk-token": token } });
  check("old kiosk token rejected", oldList.status === 401, `got ${oldList.status}`);
  const newToken = rotated.data?.kiosk_token;
  const publicList = await fetch(`${BASE}/staff/public`, { headers: { "x-kiosk-token": newToken } });
  const publicData = await publicList.json();
  check("public list works", publicList.status === 200, `got ${publicList.status}`);
  check("public list has no pin hash", publicData.every(row => !("pin_hash" in row)), JSON.stringify(publicData));

  const firstEnrollment = await admin("POST", `/staff/${rosterId}/pin-enrollment`);
  const enrollment = await admin("POST", `/staff/${rosterId}/pin-enrollment`);
  const replacedSetup = await fetch(`${BASE}/staff/${rosterId}/set-pin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468", enrollment_token: firstEnrollment.data?.enrollment_token }),
  });
  check("replaced enrollment rejected", replacedSetup.status === 404, `got ${replacedSetup.status}`);
  const setup = await fetch(`${BASE}/staff/${rosterId}/set-pin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468", enrollment_token: enrollment.data?.enrollment_token }),
  });
  check("first-use set PIN", setup.status === 204, `got ${setup.status}`);
  const managerRaceMember = await admin("POST", "/staff", { name: "Manager Race Worker" });
  const managerRaceId = managerRaceMember.data?.id;
  const managerEnrollment = await admin("POST", `/staff/${managerRaceId}/pin-enrollment`);
  const managerEnrollmentToken = managerEnrollment.data?.enrollment_token;
  const managerRaceRequests = await Promise.all([1, 2].map(() => fetch(`${BASE}/staff/${managerRaceId}/set-pin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "1357", enrollment_token: managerEnrollmentToken }),
  })));
  check("concurrent first-PIN setup exactly one winner",
    managerRaceRequests.filter(r => r.status === 204).length === 1
      && managerRaceRequests.filter(r => r.status === 409).length === 1,
    managerRaceRequests.map(r => r.status).join(","));
  const crossMember = await fetch(`${BASE}/staff/${rosterId}/set-pin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "1357", enrollment_token: managerEnrollmentToken }),
  });
  check("enrollment cannot target another member", crossMember.status === 404, `got ${crossMember.status}`);
  const enrollmentRaceMember = await admin("POST", "/staff", { name: "Enrollment Race Worker" });
  const enrollmentRaceId = enrollmentRaceMember.data?.id;
  const enrollmentRace = await Promise.all([1, 2, 3].map(() => admin("POST", `/staff/${enrollmentRaceId}/pin-enrollment`)));
  const enrollmentTokens = enrollmentRace.map(result => result.data?.enrollment_token);
  const enrollmentResults = await Promise.all(enrollmentTokens.map(token => fetch(`${BASE}/staff/${enrollmentRaceId}/set-pin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "7531", enrollment_token: token }),
  })));
  check("concurrent enrollment only newest token works",
    enrollmentResults.filter(result => result.status === 204).length === 1
      && enrollmentResults
        .filter(result => result.status !== 204)
        .every(result => result.status === 404 || result.status === 409),
    enrollmentResults.map(result => result.status).join(","));
  const verify = await fetch(`${BASE}/staff/verify-pin`, {
    method: "POST", headers: { "content-type": "application/json", "x-kiosk-token": newToken },
    body: JSON.stringify({ staff_member_id: rosterId, pin: "2468" }),
  });
  const verifyData = await verify.json();
  check("correct PIN verifies", verify.status === 200 && verifyData.verified === true, JSON.stringify(verifyData));
  check("verify defines allowed action", verifyData.action?.type === "start_shift" && verifyData.action?.label, JSON.stringify(verifyData));
  const capability = verifyData.capability;
  const wrongAction = await fetch(`${BASE}/staff/kiosk-action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, action_type: "delete_everything" }),
  });
  check("arbitrary action rejected", wrongAction.status === 403, `got ${wrongAction.status}`);
  const action = await fetch(`${BASE}/staff/kiosk-action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, action_type: "start_shift", payload: { test: true } }),
  });
  const actionData = await action.json();
  check("capability action recorded", action.status === 201
    && actionData.client_id === clientId && actionData.staff_member_id === rosterId, JSON.stringify(actionData));
  const reused = await fetch(`${BASE}/staff/kiosk-action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, action_type: "start_shift" }),
  });
  check("capability one-use", reused.status === 401, `got ${reused.status}`);

  for (let i = 1; i <= 5; i++) {
    const wrong = await fetch(`${BASE}/staff/verify-pin`, {
      method: "POST", headers: { "content-type": "application/json", "x-kiosk-token": newToken },
      body: JSON.stringify({ staff_member_id: rosterId, pin: "9999" }),
    });
    check(`wrong PIN attempt ${i}`, i === 5 ? wrong.status === 429 : wrong.status === 401, `got ${wrong.status}`);
  }
  const locked = await fetch(`${BASE}/staff/verify-pin`, {
    method: "POST", headers: { "content-type": "application/json", "x-kiosk-token": newToken },
    body: JSON.stringify({ staff_member_id: rosterId, pin: "2468" }),
  });
  check("correct PIN blocked during lockout", locked.status === 429, `got ${locked.status}`);

  const pinless = await admin("POST", "/staff", { name: "PIN-less Worker" });
  const pinlessVerify = await fetch(`${BASE}/staff/verify-pin`, {
    method: "POST", headers: { "content-type": "application/json", "x-kiosk-token": newToken },
    body: JSON.stringify({ staff_member_id: pinless.data?.id }),
  });
  const pinlessData = await pinlessVerify.json();
  check("PIN-less verify needs PIN without capability",
    pinlessVerify.status === 200 && pinlessData.needs_pin === true && !("capability" in pinlessData),
    JSON.stringify(pinlessData));

  const wrongRaceMember = await admin("POST", "/staff", { name: "Wrong Attempt Race Worker" });
  const wrongRaceId = wrongRaceMember.data?.id;
  const wrongRaceEnrollment = await admin("POST", `/staff/${wrongRaceId}/pin-enrollment`);
  const wrongRaceSetup = await fetch(`${BASE}/staff/${wrongRaceId}/set-pin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "8642", enrollment_token: wrongRaceEnrollment.data?.enrollment_token }),
  });
  check("setup concurrent-attempt member", wrongRaceSetup.status === 204, `got ${wrongRaceSetup.status}`);
  const concurrentWrong = await Promise.all(Array.from({ length: 5 }, () => fetch(`${BASE}/staff/verify-pin`, {
    method: "POST", headers: { "content-type": "application/json", "x-kiosk-token": newToken },
    body: JSON.stringify({ staff_member_id: wrongRaceId, pin: "0000" }),
  })));
  check("concurrent wrong attempts enforce lockout",
    concurrentWrong.filter(r => r.status === 429).length >= 1
      && concurrentWrong.every(r => [401, 429].includes(r.status)),
    concurrentWrong.map(r => r.status).join(","));
  const wrongRaceCorrect = await fetch(`${BASE}/staff/verify-pin`, {
    method: "POST", headers: { "content-type": "application/json", "x-kiosk-token": newToken },
    body: JSON.stringify({ staff_member_id: wrongRaceId, pin: "8642" }),
  });
  check("concurrent wrong attempts block correct PIN", wrongRaceCorrect.status === 429, `got ${wrongRaceCorrect.status}`);

  const inactive = await admin("PUT", `/staff/${rosterId}`, { active: false });
  ok("deactivate roster", inactive);
  const inactiveVerify = await fetch(`${BASE}/staff/verify-pin`, {
    method: "POST", headers: { "content-type": "application/json", "x-kiosk-token": newToken },
    body: JSON.stringify({ staff_member_id: rosterId, pin: "2468" }),
  });
  check("inactive staff rejected", inactiveVerify.status === 404, `got ${inactiveVerify.status}`);

  console.log(`staff-pin: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const failure of failures) console.error(`FAIL ${failure}`); process.exitCode = 1; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });