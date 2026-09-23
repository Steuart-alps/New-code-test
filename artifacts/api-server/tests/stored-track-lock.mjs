// Integration coverage for the date lock's authoritative, server-side lookup.
// This deliberately uses separate admin and staff cookies: a request body must
// not be able to make an old stored record look current.
const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
function session() {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = r.headers.get("content-type")?.includes("json")
      ? await r.json().catch(() => null) : null;
    return { status: r.status, data };
  };
}
const expect = (name, result, statuses) => check(name, statuses.includes(result.status), `got ${result.status}`);

async function main() {
  const admin = session();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `stored-lock-admin-${suffix}@test.local`;
  const registered = await admin("POST", "/auth/register", {
    name: "Stored Date Lock Admin", email, password: "password-123",
  });
  if (![200, 201].includes(registered.status)) throw new Error(`registration failed: ${registered.status}`);
  const token = registered.data?.verificationToken;
  if (token) expect("verify admin", await admin("GET", `/auth/verify-email?token=${encodeURIComponent(token)}`), [200]);
  expect("login admin", await admin("POST", "/auth/login", { email, password: "password-123" }), [200]);
  const me = await admin("GET", "/auth/me");
  const clientId = me.data?.user?.clientId ?? me.data?.clientId;
  check("admin has tenant", Number.isInteger(clientId), JSON.stringify(me.data));

  const staffEmail = `stored-lock-staff-${suffix}@test.local`;
  const staffCreated = await admin("POST", "/users", {
    name: "Stored Date Lock Staff", email: staffEmail, password: "password-123",
    role: "client_staff", clientId,
  });
  expect("create staff account", staffCreated, [200, 201]);
  const staff = session();
  expect("login staff", await staff("POST", "/auth/login", { email: staffEmail, password: "password-123" }), [200]);

  // Food-safety also supplies the metadata/config regression assertion.
  const configBefore = await admin("GET", "/food-safety/config");
  expect("read food config before", configBefore, [200]);
  const old = iso(-3), yesterday = iso(-1), today = iso(0);
  const foodOld = await admin("POST", "/food-safety", { recordDate: old, correctives: "seed" });
  expect("seed old food record", foodOld, [201]);
  const foodId = foodOld.data?.id;
  const foodLockedPut = await staff("PUT", `/food-safety/${foodId}`, { correctives: "staff edit" });
  check("food old PUT is locked", foodLockedPut.status === 423 && foodLockedPut.data?.code === "TRACK_RECORD_LOCKED", `${foodLockedPut.status} ${JSON.stringify(foodLockedPut.data)}`);
  const foodForged = await staff("PUT", `/food-safety/${foodId}`, { recordDate: today, correctives: "forged date" });
  check("food forged fresh date remains locked", foodForged.status === 423, `got ${foodForged.status}`);
  const foodAdminFix = await admin("PUT", `/food-safety/${foodId}`, { correctives: "admin correction" });
  expect("food admin correction works", foodAdminFix, [200]);
  const foodDeleteSeed = await admin("POST", "/food-safety", { recordDate: iso(-4) });
  const foodLockedDelete = await staff("DELETE", `/food-safety/${foodDeleteSeed.data?.id}`);
  check("food old DELETE is locked", foodLockedDelete.status === 423, `got ${foodLockedDelete.status}`);
  const foodDraft = await staff("POST", "/food-safety", { recordDate: yesterday });
  expect("food yesterday draft create", foodDraft, [201]);
  expect("food yesterday draft update", await staff("PUT", `/food-safety/${foodDraft.data?.id}`, { correctives: "draft staff edit" }), [200]);
  const configAfter = await admin("GET", "/food-safety/config");
  check("food config unaffected by record lock", JSON.stringify(configAfter.data) === JSON.stringify(configBefore.data), "config changed");

  // Representative check-based family (fire safety).
  const fireOld = await admin("POST", "/fire-safety", { checkType: "alarm", checkDate: old, result: "pass", performedBy: "Admin" });
  expect("seed old fire record", fireOld, [201]);
  const fireId = fireOld.data?.id;
  check("fire old PUT is locked", (await staff("PUT", `/fire-safety/${fireId}`, { notes: "staff edit" })).status === 423);
  check("fire forged date remains locked", (await staff("PUT", `/fire-safety/${fireId}`, { checkDate: today, notes: "forged" })).status === 423);
  expect("fire admin correction works", await admin("PUT", `/fire-safety/${fireId}`, { notes: "admin correction" }), [200]);
  const fireDeleteSeed = await admin("POST", "/fire-safety", { checkType: "alarm", checkDate: iso(-4), result: "pass" });
  check("fire old DELETE is locked", (await staff("DELETE", `/fire-safety/${fireDeleteSeed.data?.id}`)).status === 423);
  const fireDraft = await staff("POST", "/fire-safety", { checkType: "alarm", checkDate: today, result: "pass" });
  expect("fire today draft create", fireDraft, [201]);
  expect("fire today draft update", await staff("PUT", `/fire-safety/${fireDraft.data?.id}`, { notes: "draft staff edit" }), [200]);

  // AM checklists exercise a route whose date is named checkDate.
  const amOld = await admin("POST", "/daily-track-am", {
    checklistType: "kitchen_opening", checkDate: old, items: [],
  });
  if (amOld.status === 403) {
    check("daily AM entitlement available", false, JSON.stringify(amOld.data));
  } else {
    expect("seed old daily AM record", amOld, [201]);
    const amId = amOld.data?.id;
    check("daily AM old PUT is locked", (await staff("PUT", `/daily-track-am/${amId}`, { managerNote: "staff edit" })).status === 423);
    check("daily AM forged date remains locked", (await staff("PUT", `/daily-track-am/${amId}`, { checkDate: today, managerNote: "forged" })).status === 423);
    expect("daily AM admin correction works", await admin("PUT", `/daily-track-am/${amId}`, { managerNote: "admin correction" }), [200]);
    const amDeleteSeed = await admin("POST", "/daily-track-am", { checklistType: "kitchen_opening", checkDate: iso(-4), items: [] });
    check("daily AM old DELETE is locked", (await staff("DELETE", `/daily-track-am/${amDeleteSeed.data?.id}`)).status === 423);
    const amDraft = await staff("POST", "/daily-track-am", { checklistType: "kitchen_opening", checkDate: yesterday, items: [] });
    expect("daily AM yesterday draft create", amDraft, [201]);
    expect("daily AM yesterday draft update", await staff("PUT", `/daily-track-am/${amDraft.data?.id}`, { managerNote: "draft staff edit" }), [200]);
  }

  // Additional families with deliberately small payloads.  A 403 here is a
  // failure (rather than an entitlement skip): self-registered fixtures must
  // expose the services exercised by this regression suite.
  const family = async (label, collection, createBody, freshBody, updateBody = { notes: "admin correction" }) => {
    const seeded = await admin("POST", collection, createBody);
    expect(`${label}: seed old record`, seeded, [201]);
    if (seeded.status !== 201) return;
    let id = seeded.data?.id;
    if (collection === "/pool-track" && !id) {
      // The legacy pool POST responds with an empty body; find this fixture
      // through the tenant-scoped list rather than assuming a returned id.
      const listed = await admin("GET", "/pool-track");
      id = listed.data?.find?.(row => row.notes === createBody.notes)?.id;
    }
    check(`${label}: seeded id available`, Number.isInteger(id));
    if (!Number.isInteger(id)) return;
    const locked = await staff("PUT", `${collection}/${id}`, updateBody);
    check(`${label}: old PUT is locked`, locked.status === 423, `got ${locked.status}`);
    const forged = await staff("PUT", `${collection}/${id}`, freshBody);
    check(`${label}: forged fresh date remains locked`, forged.status === 423, `got ${forged.status}`);
    expect(`${label}: admin correction works`, await admin("PUT", `${collection}/${id}`, updateBody), [200]);
    const deleteSeed = await admin("POST", collection, { ...createBody, notes: "delete seed" });
    expect(`${label}: seed delete record`, deleteSeed, [201]);
    if (deleteSeed.status === 201) {
      let deleteId = deleteSeed.data?.id;
      if (collection === "/pool-track" && !deleteId) {
        const listed = await admin("GET", "/pool-track");
        deleteId = listed.data?.find?.(row => row.notes === "delete seed")?.id;
      }
      check(`${label}: delete fixture id available`, Number.isInteger(deleteId));
      if (Number.isInteger(deleteId)) {
        check(`${label}: old DELETE is locked`, (await staff("DELETE", `${collection}/${deleteId}`)).status === 423);
      }
    }
  };

  await family("SafeTrack training", "/safe-track/training-records", {
    staffName: "Lock Fixture", trainingType: "Manual handling", completedAt: old, notes: "seed",
  }, { completedAt: today, notes: "forged" });
  await family("pool-track", "/pool-track", {
    checkDate: old, checkType: "routine", result: "pass", performedBy: "Admin", phLevel: 7.4, notes: `pool-lock-${suffix}`,
  }, { checkDate: today, notes: "forged" });
  await family("tree-track", "/tree-track", {
    checkType: "visual_assessment", checkDate: old, result: "pass", treeRef: "LOCK-1", inspector: "Admin",
  }, { checkDate: today, notes: "forged" });
  await family("pest-track visits", "/pest-track/visits", {
    visitDate: old, contractorName: "Lock Pest Control", findings: "none",
  }, { visitDate: today, notes: "forged" }, { visitDate: old, notes: "admin correction" });

  const trainOld = await admin("POST", "/train-track/records", {
    recordType: "internal", staffName: "Lock Fixture", trainingType: "Safety",
    trainer: "Admin", completedDate: old,
  });
  expect("TrainTrack: seed old record", trainOld, [201]);
  if (trainOld.status === 201) {
    const path = `/train-track/records/${trainOld.data?.id}`;
    const locked = await staff("PATCH", path, { notes: "staff edit" });
    check("TrainTrack: old PATCH is locked", locked.status === 423 && locked.data?.code === "TRACK_RECORD_LOCKED");
    check("TrainTrack: forged date PATCH stays locked",
      (await staff("PATCH", path, { completedDate: today, notes: "forged" })).status === 423);
    expect("TrainTrack: admin PATCH correction works", await admin("PATCH", path, { notes: "admin correction" }), [200]);
  }

  console.log(`stored-track-lock: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  }
}
main().catch((error) => { console.error("stored-track-lock crashed:", error); process.exitCode = 1; });