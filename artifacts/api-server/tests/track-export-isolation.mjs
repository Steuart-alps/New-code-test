import { writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function expectStatus(name, response, expected) {
  check(name, expected.includes(response.status), `expected ${expected.join("/")}, got ${response.status}`);
}

function session() {
  let cookie = "";
  const request = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (response.headers.get("content-type") || "").includes("application/json")
      ? await response.json().catch(() => null) : null;
    return { status: response.status, data, response };
  };
  request.cookie = () => cookie;
  return request;
}

async function register(request, label, stamp) {
  const email = `track-export-${label}-${stamp}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: `${label} export owner`, email, password: "password-123",
  });
  expectStatus(`${label} registers`, registered, [200, 201]);
  expectStatus(`${label} verifies`, await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data?.verificationToken)}`), [200]);
  expectStatus(`${label} logs in`, await request("POST", "/auth/login", { email, password: "password-123" }), [200]);
  return request("GET", "/auth/me");
}

function zipCsv(path, filename) {
  return execFileSync("unzip", ["-p", path, filename], { encoding: "utf8" });
}

async function exportZip(request, path) {
  const response = await fetch(`${BASE}/export`, { headers: { cookie: request.cookie() } });
  check("download tenant export", response.status === 200, `got ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).split("\n");
}

async function main() {
  const stamp = Date.now();
  const owner = session();
  const ownerMe = await register(owner, "owner", stamp);
  const ownerClientId = (ownerMe.data?.user ?? ownerMe.data)?.clientId;
  const ownerSite = await owner("POST", "/sites", { name: `Owner site ${stamp}`, seedStarterChecks: false });
  expectStatus("create owner site", ownerSite, [201]);

  const reviewerEmail = `track-export-reviewer-${stamp}@test.local`;
  expectStatus("create independent reviewer", await owner("POST", "/users", {
    name: "Independent reviewer", email: reviewerEmail, password: "password-456",
    role: "client_staff", clientId: ownerClientId,
  }), [200, 201]);
  const reviewer = session();
  expectStatus("reviewer logs in", await reviewer("POST", "/auth/login", {
    email: reviewerEmail, password: "password-456",
  }), [200]);

  const ownerMarkers = {
    fireProfile: `FRA-OWNER-${stamp}`,
    legionellaProfile: `WCS-OWNER-${stamp}`,
    fireAction: `Fire owner action ${stamp}`,
    legionellaAction: `Legionella owner action ${stamp}`,
    fireEvidence: `Fire reviewed evidence ${stamp}`,
    legionellaEvidence: `Legionella reviewed evidence ${stamp}`,
  };
  expectStatus("save owner FireTrack profile", await owner("PUT", `/fire-safety/config?siteId=${ownerSite.data?.id}`, {
    controlProfile: { riskAssessmentReference: ownerMarkers.fireProfile, frequencyDays: { alarm: 14 } },
  }), [200]);
  expectStatus("save owner LegionellaTrack profile", await owner("PUT", `/legionella/config?siteId=${ownerSite.data?.id}`, {
    controlProfile: { writtenControlSchemeReference: ownerMarkers.legionellaProfile, frequencyDays: { hot_sentinel_temp: 45 } },
  }), [200]);

  const fireRequirements = await owner("GET", "/track-evidence/requirements?module=fire");
  const legionellaRequirements = await owner("GET", "/track-evidence/requirements?module=legionella");
  expectStatus("seed owner FireTrack requirements", fireRequirements, [200]);
  expectStatus("seed owner LegionellaTrack requirements", legionellaRequirements, [200]);
  const fireRequirement = fireRequirements.data?.[0];
  const legionellaRequirement = legionellaRequirements.data?.[0];

  const fireAction = await owner("POST", "/track-actions", {
    module: "fire", siteId: ownerSite.data?.id, title: ownerMarkers.fireAction, severity: "action_required",
  });
  const legionellaAction = await owner("POST", "/track-actions", {
    module: "legionella", siteId: ownerSite.data?.id, title: ownerMarkers.legionellaAction, severity: "action_required",
  });
  expectStatus("create owner FireTrack action", fireAction, [201]);
  expectStatus("create owner LegionellaTrack action", legionellaAction, [201]);

  const fireEvidence = await owner("POST", "/track-evidence", {
    module: "fire", siteId: ownerSite.data?.id, actionId: fireAction.data?.id,
    requirementKey: fireRequirement?.requirementKey, evidenceType: fireRequirement?.evidenceType,
    title: ownerMarkers.fireEvidence, details: "Inspection evidence.",
  });
  const legionellaEvidence = await owner("POST", "/track-evidence", {
    module: "legionella", siteId: ownerSite.data?.id, actionId: legionellaAction.data?.id,
    requirementKey: legionellaRequirement?.requirementKey, evidenceType: legionellaRequirement?.evidenceType,
    title: ownerMarkers.legionellaEvidence, details: "Inspection evidence.",
  });
  expectStatus("create owner FireTrack evidence", fireEvidence, [201]);
  expectStatus("create owner LegionellaTrack evidence", legionellaEvidence, [201]);
  expectStatus("review FireTrack evidence independently", await reviewer("POST", `/track-evidence/${fireEvidence.data?.id}/review`, {
    status: "verified", reviewNotes: "Independently checked.",
  }), [200]);
  expectStatus("review LegionellaTrack evidence independently", await reviewer("POST", `/track-evidence/${legionellaEvidence.data?.id}/review`, {
    status: "verified", reviewNotes: "Independently checked.",
  }), [200]);

  const other = session();
  await register(other, "other", stamp);
  const otherSite = await other("POST", "/sites", { name: `Other site ${stamp}`, seedStarterChecks: false });
  expectStatus("create other tenant site", otherSite, [201]);
  const otherMarkers = {
    fireProfile: `FRA-OTHER-${stamp}`,
    legionellaProfile: `WCS-OTHER-${stamp}`,
    fireAction: `Fire other action ${stamp}`,
    legionellaAction: `Legionella other action ${stamp}`,
    fireEvidence: `Fire other evidence ${stamp}`,
    legionellaEvidence: `Legionella other evidence ${stamp}`,
  };
  expectStatus("save other FireTrack profile", await other("PUT", `/fire-safety/config?siteId=${otherSite.data?.id}`, {
    controlProfile: { riskAssessmentReference: otherMarkers.fireProfile, frequencyDays: { alarm: 21 } },
  }), [200]);
  expectStatus("save other LegionellaTrack profile", await other("PUT", `/legionella/config?siteId=${otherSite.data?.id}`, {
    controlProfile: { writtenControlSchemeReference: otherMarkers.legionellaProfile, frequencyDays: { hot_sentinel_temp: 60 } },
  }), [200]);
  const otherFireAction = await other("POST", "/track-actions", {
    module: "fire", siteId: otherSite.data?.id, title: otherMarkers.fireAction, severity: "monitor",
  });
  const otherLegionellaAction = await other("POST", "/track-actions", {
    module: "legionella", siteId: otherSite.data?.id, title: otherMarkers.legionellaAction, severity: "monitor",
  });
  expectStatus("create other FireTrack action", otherFireAction, [201]);
  expectStatus("create other LegionellaTrack action", otherLegionellaAction, [201]);
  expectStatus("create other FireTrack evidence", await other("POST", "/track-evidence", {
    module: "fire", siteId: otherSite.data?.id, actionId: otherFireAction.data?.id,
    evidenceType: "verification", title: otherMarkers.fireEvidence, details: "Other tenant evidence.",
  }), [201]);
  expectStatus("create other LegionellaTrack evidence", await other("POST", "/track-evidence", {
    module: "legionella", siteId: otherSite.data?.id, actionId: otherLegionellaAction.data?.id,
    evidenceType: "verification", title: otherMarkers.legionellaEvidence, details: "Other tenant evidence.",
  }), [201]);

  const ownerPath = join(tmpdir(), `track-owner-export-${stamp}.zip`);
  const otherPath = join(tmpdir(), `track-other-export-${stamp}.zip`);
  const files = [
    "fire-safety/control-profiles.csv", "fire-safety/evidence-requirements.csv",
    "fire-safety/evidence.csv", "fire-safety/actions.csv",
    "legionella/control-profiles.csv", "legionella/evidence-requirements.csv",
    "legionella/evidence.csv", "legionella/actions.csv",
  ];
  try {
    const ownerEntries = await exportZip(owner, ownerPath);
    for (const file of files) check(`owner export contains ${file}`, ownerEntries.includes(file));
    const ownerCsv = Object.fromEntries(files.map(file => [file, zipCsv(ownerPath, file)]));
    check("owner export contains FireTrack profile", ownerCsv["fire-safety/control-profiles.csv"].includes(ownerMarkers.fireProfile));
    check("owner export contains LegionellaTrack profile", ownerCsv["legionella/control-profiles.csv"].includes(ownerMarkers.legionellaProfile));
    check("owner export contains FireTrack requirement", ownerCsv["fire-safety/evidence-requirements.csv"].includes(fireRequirement?.requirementKey));
    check("owner export contains LegionellaTrack requirement", ownerCsv["legionella/evidence-requirements.csv"].includes(legionellaRequirement?.requirementKey));
    check("owner export contains reviewed FireTrack evidence", ownerCsv["fire-safety/evidence.csv"].includes(ownerMarkers.fireEvidence) && ownerCsv["fire-safety/evidence.csv"].includes("verified"));
    check("owner export contains reviewed LegionellaTrack evidence", ownerCsv["legionella/evidence.csv"].includes(ownerMarkers.legionellaEvidence) && ownerCsv["legionella/evidence.csv"].includes("verified"));
    check("owner export contains FireTrack action", ownerCsv["fire-safety/actions.csv"].includes(ownerMarkers.fireAction));
    check("owner export contains LegionellaTrack action", ownerCsv["legionella/actions.csv"].includes(ownerMarkers.legionellaAction));
    check("owner export excludes other tenant profiles", !ownerCsv["fire-safety/control-profiles.csv"].includes(otherMarkers.fireProfile) && !ownerCsv["legionella/control-profiles.csv"].includes(otherMarkers.legionellaProfile));
    check("owner export excludes other tenant evidence", !ownerCsv["fire-safety/evidence.csv"].includes(otherMarkers.fireEvidence) && !ownerCsv["legionella/evidence.csv"].includes(otherMarkers.legionellaEvidence));

    await exportZip(other, otherPath);
    const otherFireProfiles = zipCsv(otherPath, "fire-safety/control-profiles.csv");
    const otherLegionellaProfiles = zipCsv(otherPath, "legionella/control-profiles.csv");
    const otherFireEvidence = zipCsv(otherPath, "fire-safety/evidence.csv");
    const otherLegionellaEvidence = zipCsv(otherPath, "legionella/evidence.csv");
    check("other export contains its profiles", otherFireProfiles.includes(otherMarkers.fireProfile) && otherLegionellaProfiles.includes(otherMarkers.legionellaProfile));
    check("other export contains its evidence", otherFireEvidence.includes(otherMarkers.fireEvidence) && otherLegionellaEvidence.includes(otherMarkers.legionellaEvidence));
    check("other export excludes owner profiles", !otherFireProfiles.includes(ownerMarkers.fireProfile) && !otherLegionellaProfiles.includes(ownerMarkers.legionellaProfile));
    check("other export excludes owner evidence", !otherFireEvidence.includes(ownerMarkers.fireEvidence) && !otherLegionellaEvidence.includes(ownerMarkers.legionellaEvidence));
  } finally {
    await rm(ownerPath, { force: true });
    await rm(otherPath, { force: true });
  }

  console.log(`track export isolation tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});