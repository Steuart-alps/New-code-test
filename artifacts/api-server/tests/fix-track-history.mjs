// Focused FixTrack detail/history regression coverage.
// Usage: node tests/fix-track-history.mjs (with the API server and DATABASE_URL set).
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const execFile = promisify(execFileCallback);
const date = new Date().toISOString().slice(0, 10);
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
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

async function tenant(label) {
  const req = session();
  const email = `fix-history-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await req("POST", "/auth/register", {
    name: `${label} FixTrack User`, email, password: "password-123",
  });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  if (!registered.data?.verificationToken) throw new Error(`${label}: missing verification token`);
  check(`${label}: verify`, (await req("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);
  check(`${label}: login`, (await req("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  return req;
}

async function userSession(owner, label, role, clientId, departmentId) {
  const email = `fix-history-${label}-${Date.now()}-${Math.random()}@test.local`;
  const created = await owner("POST", "/users", {
    name: `${label} user`, email, password: "password-123", role, clientId,
    ...(departmentId === undefined ? {} : { departmentId }),
  });
  check(`${label}: create ${role}`, created.status === 201, String(created.status));
  const req = session();
  check(`${label}: login`, (await req("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  return req;
}

async function createActionToken(issueId, clientId, action) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await execFile("psql", [
    process.env.DATABASE_URL,
    "-v", "ON_ERROR_STOP=1",
    "-At",
    "-c",
    `INSERT INTO fix_track_action_tokens (token, token_hash, issue_id, client_id, action, expires_at)
     VALUES (NULL, '${tokenHash}', ${Number(issueId)}, ${Number(clientId)}, '${action}', now() + interval '1 hour')
     RETURNING id`,
  ]);
  return token;
}

async function main() {
  const owner = await tenant("owner");
  const otherTenant = await tenant("other");
  const ownerMe = await owner("GET", "/auth/me");
  const ownerClientId = ownerMe.data?.user?.clientId ?? ownerMe.data?.client?.id;
  if (!ownerClientId) throw new Error("Could not determine owner tenant for FixTrack fixtures");
  const viewer = await userSession(owner, "viewer", "client_viewer", ownerClientId);
  const created = await owner("POST", "/fix-track/issues", {
    title: "History ordering regression", issueType: "general", location: "Plant room",
    reportedBy: "Facilities team", reportedDate: date,
  });
  check("create reported issue", created.status === 201, String(created.status));
  const id = created.data?.id;
  const openWork = await owner("GET", "/fix-track/issues?status=reported&status=in_progress");
  check("mobile open-work list includes reported issue",
    openWork.status === 200 && Array.isArray(openWork.data) && openWork.data.some((issue) => issue.id === id),
    JSON.stringify(openWork.data));

  check("reject skipped reported → resolved transition",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "resolved" })).status === 409);
  check("reject skipped reported → closed transition",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "closed" })).status === 409);
  check("viewer cannot create a FixTrack issue",
    (await viewer("POST", "/fix-track/issues", {
      title: "Viewer must not create", issueType: "general", location: "Plant room",
      reportedBy: "Viewer", reportedDate: date,
    })).status === 403);
  check("viewer cannot change issue status",
    (await viewer("PUT", `/fix-track/issues/${id}`, { status: "in_progress" })).status === 403);
  check("viewer cannot request an issue media upload",
    (await viewer("POST", `/fix-track/issues/${id}/request-upload`, {
      name: "photo.jpg", contentType: "image/jpeg",
    })).status === 403);
  check("viewer cannot attach issue media",
    (await viewer("POST", `/fix-track/issues/${id}/media`, {
      objectPath: `/objects/uploads/tenant-${ownerClientId}/viewer-photo.jpg`,
    })).status === 403);
  check("viewer cannot append issue notes",
    (await viewer("POST", `/fix-track/issues/${id}/notes`, { note: "Viewer must not add this" })).status === 403);
  check("viewer cannot delete an issue",
    (await viewer("DELETE", `/fix-track/issues/${id}`)).status === 403);
  check("advance reported → in progress",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "in_progress" })).status === 200);
  check("reject backward in progress → reported transition",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "reported" })).status === 409);
  check("append attributed note",
    (await owner("POST", `/fix-track/issues/${id}/notes`, { note: "Engineer booked" })).status === 200);
  check("reject resolution without drawn signature",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "resolved" })).status === 400);
  check("advance in progress → resolved",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "resolved", resolverSignature: SIGNATURE })).status === 200);
  check("reject backward resolved → in progress transition",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "in_progress" })).status === 409);
  check("advance resolved → closed",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "closed" })).status === 200);
  check("reject backward closed → resolved transition",
    (await owner("PUT", `/fix-track/issues/${id}`, { status: "resolved", resolverSignature: SIGNATURE })).status === 409);

  const detail = await owner("GET", `/fix-track/issues/${id}`);
  check("manager/mobile detail loads", detail.status === 200, String(detail.status));
  check("resolved issue snapshots authenticated resolver name",
    detail.data?.resolvedByName === "owner FixTrack User",
    JSON.stringify(detail.data));
  check("resolved issue stores drawn signature", detail.data?.resolverSignature === SIGNATURE);
  check("status history is chronological and complete",
    JSON.stringify(detail.data?.statusEvents?.map((event) => event.status)) ===
      JSON.stringify(["reported", "in_progress", "resolved", "closed"]),
    JSON.stringify(detail.data?.statusEvents));
  check("note is retained with its authenticated author",
    detail.data?.notes?.length === 1 &&
      detail.data.notes[0].note === "Engineer booked" &&
      detail.data.notes[0].createdBy === "owner FixTrack User" &&
      typeof detail.data.notes[0].createdAt === "string" &&
      Number.isFinite(Date.parse(detail.data.notes[0].createdAt)),
    JSON.stringify(detail.data?.notes));

  for (const [label, method, path, body] of [
    ["foreign detail", "GET", `/fix-track/issues/${id}`],
    ["foreign transition", "PUT", `/fix-track/issues/${id}`, { status: "in_progress" }],
    ["foreign note", "POST", `/fix-track/issues/${id}/notes`, { note: "unauthorised" }],
  ]) {
    const result = await otherTenant(method, path, body);
    check(`tenant isolation: ${label}`, [400, 403, 404].includes(result.status), String(result.status));
  }

  const alphaDept = await owner("POST", "/departments", { name: `FixTrack Alpha ${Date.now()}` });
  const betaDept = await owner("POST", "/departments", { name: `FixTrack Beta ${Date.now()}` });
  check("create departments for FixTrack note isolation",
    alphaDept.status === 201 && betaDept.status === 201);
  if (alphaDept.status !== 201 || betaDept.status !== 201) throw new Error("Could not create FixTrack departments");
  const alphaSite = await owner("POST", "/sites", {
    name: `FixTrack Alpha site ${Date.now()}`, departmentId: alphaDept.data.id, seedStarterChecks: false,
  });
  const betaSite = await owner("POST", "/sites", {
    name: `FixTrack Beta site ${Date.now()}`, departmentId: betaDept.data.id, seedStarterChecks: false,
  });
  check("create department-scoped sites", alphaSite.status === 201 && betaSite.status === 201);
  if (alphaSite.status !== 201 || betaSite.status !== 201) throw new Error("Could not create FixTrack test sites");
  const alphaStaff = await userSession(owner, "alpha-staff", "client_staff", ownerClientId, alphaDept.data.id);
  const alphaIssue = await owner("POST", "/fix-track/issues", {
    title: "Alpha department note scope", issueType: "general", location: "Alpha plant room",
    reportedBy: "Facilities", reportedDate: date, siteId: alphaSite.data.id,
  });
  const betaIssue = await owner("POST", "/fix-track/issues", {
    title: "Beta department note scope", issueType: "general", location: "Beta plant room",
    reportedBy: "Facilities", reportedDate: date, siteId: betaSite.data.id,
  });
  check("create department-scoped FixTrack issues", alphaIssue.status === 201 && betaIssue.status === 201);
  if (alphaIssue.status !== 201 || betaIssue.status !== 201) throw new Error("Could not create FixTrack department issues");
  check("staff can add a note within their department",
    (await alphaStaff("POST", `/fix-track/issues/${alphaIssue.data.id}/notes`, { note: "Alpha-only observation" })).status === 200);
  const alphaDetail = await alphaStaff("GET", `/fix-track/issues/${alphaIssue.data.id}`);
  check("department note returns its author and timestamp",
    alphaDetail.status === 200 &&
      alphaDetail.data?.notes?.some(note => note.note === "Alpha-only observation" &&
        note.createdBy === "alpha-staff user" && Number.isFinite(Date.parse(note.createdAt))),
    JSON.stringify(alphaDetail.data?.notes));
  check("staff cannot read another department's issue history",
    (await alphaStaff("GET", `/fix-track/issues/${betaIssue.data.id}`)).status === 404);
  check("staff cannot append a note to another department's issue",
    (await alphaStaff("POST", `/fix-track/issues/${betaIssue.data.id}/notes`, { note: "Must remain private" })).status === 404);

  const raceIssue = await owner("POST", "/fix-track/issues", {
    title: "Concurrent status event regression", issueType: "general", location: "Plant room",
    reportedBy: "Facilities", reportedDate: date,
  });
  check("create issue for concurrent status transition", raceIssue.status === 201);
  if (raceIssue.status !== 201) throw new Error("Could not create concurrent transition issue");
  const statusRace = await Promise.all([
    owner("PUT", `/fix-track/issues/${raceIssue.data.id}`, { status: "in_progress" }),
    owner("PUT", `/fix-track/issues/${raceIssue.data.id}`, { status: "in_progress" }),
  ]);
  check("concurrent status requests leave the issue in the valid next state",
    statusRace.every(result => [200, 409].includes(result.status)) &&
      statusRace.some(result => result.status === 200),
    JSON.stringify(statusRace));
  const raceDetail = await owner("GET", `/fix-track/issues/${raceIssue.data.id}`);
  check("concurrent status update appends exactly one event",
    raceDetail.data?.statusEvents?.filter(event => event.status === "in_progress").length === 1,
    JSON.stringify(raceDetail.data?.statusEvents));

  const publicIssue = await owner("POST", "/fix-track/issues", {
    title: "One-use contractor action regression", issueType: "general", location: "Plant room",
    reportedBy: "Facilities", reportedDate: date,
  });
  check("create issue for public contractor actions", publicIssue.status === 201);
  if (publicIssue.status !== 201) throw new Error("Could not create public-action issue");
  const bookedToken = await createActionToken(publicIssue.data.id, ownerClientId, "booked");
  const completedToken = await createActionToken(publicIssue.data.id, ownerClientId, "completed");
  const completedPage = await fetch(`${BASE}/fix-track/action/${completedToken}`);
  check("completed contractor token resolves publicly", completedPage.status === 200,
    `${completedPage.status}; content-type ${completedPage.headers.get("content-type")}`);
  const prematureCompletion = await fetch(`${BASE}/fix-track/action/${completedToken}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes: "Must not resolve before booking" }),
  });
  check("completion token cannot skip the reported → in-progress step",
    prematureCompletion.status === 409, `${prematureCompletion.status}: ${await prematureCompletion.text()}`);
  const bookedRace = await Promise.all([
    fetch(`${BASE}/fix-track/action/${bookedToken}/booked`, { method: "POST" }),
    fetch(`${BASE}/fix-track/action/${bookedToken}/booked`, { method: "POST" }),
  ]);
  const bookedStatuses = bookedRace.map(response => response.status);
  const bookedBodies = await Promise.all(bookedRace.map(response => response.text()));
  check("concurrent reuse of a booked token creates one event",
    bookedStatuses.filter(status => status === 200).length === 1 &&
      bookedStatuses.filter(status => status === 409).length === 1,
    JSON.stringify({ statuses: bookedStatuses, bodies: bookedBodies }));
  const repeatedBooked = await fetch(`${BASE}/fix-track/action/${bookedToken}/booked`, { method: "POST" });
  check("reusing an already actioned booked token is rejected", repeatedBooked.status === 409,
    `${repeatedBooked.status}: ${await repeatedBooked.text()}`);
  const completionRace = await Promise.all([
    fetch(`${BASE}/fix-track/action/${completedToken}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Contractor completion note" }),
    }),
    fetch(`${BASE}/fix-track/action/${completedToken}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Duplicate completion must not persist" }),
    }),
  ]);
  const completionStatuses = completionRace.map(response => response.status);
  const completionBodies = await Promise.all(completionRace.map(response => response.text()));
  check("concurrent reuse of a completed token creates one event",
    completionStatuses.filter(status => status === 200).length === 1 &&
      completionStatuses.filter(status => status === 409).length === 1,
    JSON.stringify({ statuses: completionStatuses, bodies: completionBodies }));
  const repeatedCompletion = await fetch(`${BASE}/fix-track/action/${completedToken}`, { method: "POST" });
  check("reusing an already actioned completion token is rejected", repeatedCompletion.status === 409,
    `${repeatedCompletion.status}: ${await repeatedCompletion.text()}`);
  const publicDetail = await owner("GET", `/fix-track/issues/${publicIssue.data.id}`);
  check("contractor events preserve the full public status history exactly once",
    JSON.stringify(publicDetail.data?.statusEvents?.map(event => event.status)) ===
      JSON.stringify(["reported", "in_progress", "resolved"]),
    JSON.stringify(publicDetail.data?.statusEvents));
  const bookingActivityNotes = publicDetail.data?.notes?.filter(note =>
    note.note === "Marked as booked by contractor via email") ?? [];
  const completionActivityNotes = publicDetail.data?.notes?.filter(note =>
    note.note === "Marked as completed by contractor via email") ?? [];
  check("contractor booking and completion activity notes are recorded once with timestamps",
    bookingActivityNotes.length === 1 &&
      completionActivityNotes.length === 1 &&
      [...bookingActivityNotes, ...completionActivityNotes].every(note =>
        note.createdBy === "Former user" && Number.isFinite(Date.parse(note.createdAt))),
    JSON.stringify(publicDetail.data?.notes));
  const completionNotes = publicDetail.data?.notes?.filter(note => note.note === "Contractor completion note") ?? [];
  check("contractor-supplied completion note is attributed and timestamped once",
    completionNotes.length === 1 &&
      completionNotes.every(note => note.createdBy === "Former user" && Number.isFinite(Date.parse(note.createdAt))) &&
      !publicDetail.data?.notes?.some(note => note.note === "Duplicate completion must not persist"),
    JSON.stringify(publicDetail.data?.notes));

  console.log(`${passed} FixTrack history checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });