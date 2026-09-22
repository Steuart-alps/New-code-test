import { execFileSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const stamp = Date.now();
let passed = 0;

function assert(name, condition, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  passed++;
}

function expectStatus(name, response, expected) {
  assert(name, expected.includes(response.status), `expected ${expected.join("/")}, got ${response.status}`);
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

async function register(request, label) {
  const email = `pat-attachment-${label}-${stamp}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: `PAT attachment ${label}`, email, password: "password-123",
  });
  expectStatus(`${label} registers`, registered, [200, 201]);
  assert(`${label} receives verification token`, typeof registered.data?.verificationToken === "string");
  expectStatus(`${label} verifies`, await request(
    "GET",
    `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`,
  ), [200]);
  expectStatus(`${label} logs in`, await request("POST", "/auth/login", {
    email, password: "password-123",
  }), [200]);
}

async function createSite(request, name) {
  const site = await request("POST", "/sites", { name, seedStarterChecks: false });
  expectStatus(`create ${name}`, site, [201]);
  return site.data;
}

async function createDocument(request, siteId, title) {
  const requested = await request("POST", "/doc-track/documents/request-upload", {
    name: `${title}.txt`, contentType: "text/plain",
  });
  if ([500, 502, 503].includes(requested.status)) return { unavailable: requested };
  expectStatus(`request upload for ${title}`, requested, [200]);
  assert(`upload URL returned for ${title}`, typeof requested.data?.uploadUrl === "string");
  assert(`object path returned for ${title}`, typeof requested.data?.objectPath === "string");
  const uploaded = await fetch(requested.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: title,
  });
  assert(`upload ${title}`, uploaded.ok, `got ${uploaded.status}`);
  const created = await request("POST", "/doc-track/documents", {
    title,
    category: "other",
    fileName: `${title}.txt`,
    fileSize: Buffer.byteLength(title),
    mimeType: "text/plain",
    objectPath: requested.data.objectPath,
    siteId,
  });
  expectStatus(`finalize ${title}`, created, [201]);
  return { document: created.data, content: title };
}

async function main() {
  const owner = session();
  await register(owner, "owner");
  const alphaSite = await createSite(owner, `PAT attachment alpha ${stamp}`);
  const betaSite = await createSite(owner, `PAT attachment beta ${stamp}`);

  const alpha = await createDocument(owner, alphaSite.id, `PAT alpha evidence ${stamp}`);
  if (alpha.unavailable) {
    console.log(`SKIP: PAT attachment export integration requires object storage; upload reservation returned HTTP ${alpha.unavailable.status}`);
    return;
  }
  const beta = await createDocument(owner, betaSite.id, `PAT beta evidence ${stamp}`);
  assert("storage remains available for second fixture", !beta.unavailable);

  const alphaTemplate = await owner("POST", "/pat-track/equipment-templates", {
    siteId: alphaSite.id, name: "Attachment template",
  });
  expectStatus("create PAT template", alphaTemplate, [201]);
  const alphaRoom = await owner("POST", "/pat-track/rooms", {
    siteId: alphaSite.id, templateId: alphaTemplate.data.id, name: "Attachment room",
  });
  expectStatus("create PAT room", alphaRoom, [201]);
  const certificateBody = {
    siteId: alphaSite.id,
    roomIds: [alphaRoom.data.id],
    visitDate: "2025-01-10",
    certificateRef: `ATTACH-${stamp}`,
  };
  const certificate = await owner("POST", "/pat-track/certificates", certificateBody);
  expectStatus("create PAT certificate", certificate, [201]);
  expectStatus("reject cross-site document on certificate create", await owner("POST", "/pat-track/certificates", {
    ...certificateBody,
    certificateRef: `CROSS-${stamp}`,
    documentId: beta.document.id,
  }), [400]);
  expectStatus("reject cross-site document on certificate update", await owner("PUT", `/pat-track/certificates/${certificate.data.id}`, {
    ...certificateBody,
    documentId: beta.document.id,
  }), [400]);
  expectStatus("link same-site document to certificate", await owner("PUT", `/pat-track/certificates/${certificate.data.id}`, {
    ...certificateBody,
    documentId: alpha.document.id,
  }), [200]);

  const foreign = session();
  await register(foreign, "foreign");
  const foreignSite = await createSite(foreign, `PAT attachment foreign ${stamp}`);
  const foreignDocument = await createDocument(foreign, foreignSite.id, `PAT foreign evidence ${stamp}`);
  assert("storage remains available for foreign fixture", !foreignDocument.unavailable);

  const response = await fetch(`${BASE}/export`, { headers: { cookie: owner.cookie() } });
  assert("download owner export", response.status === 200, `got ${response.status}`);
  const exportPath = join(tmpdir(), `pat-attachment-export-${stamp}.zip`);
  try {
    await writeFile(exportPath, Buffer.from(await response.arrayBuffer()));
    const entries = execFileSync("unzip", ["-Z1", exportPath], { encoding: "utf8" }).split("\n");
    const manifest = execFileSync("unzip", ["-p", exportPath, "attachment-manifest.csv"], { encoding: "utf8" });
    assert("manifest includes alpha document", manifest.includes(`doc-track,${alpha.document.id},`) && manifest.includes(alpha.document.objectPath));
    assert("manifest includes beta document", manifest.includes(`doc-track,${beta.document.id},`) && manifest.includes(beta.document.objectPath));
    assert("manifest records included attachments", manifest.includes(",included,"));
    assert("manifest excludes foreign tenant document", !manifest.includes(foreignDocument.document.objectPath));

    const alphaEntry = entries.find((entry) => entry.startsWith("attachments/doc-track/") && entry.includes(`PAT alpha evidence ${stamp}`));
    const betaEntry = entries.find((entry) => entry.startsWith("attachments/doc-track/") && entry.includes(`PAT beta evidence ${stamp}`));
    assert("ZIP contains alpha document", typeof alphaEntry === "string");
    assert("ZIP contains beta document", typeof betaEntry === "string");
    assert("ZIP alpha document retains content", execFileSync("unzip", ["-p", exportPath, alphaEntry], { encoding: "utf8" }) === alpha.content);
    assert("ZIP beta document retains content", execFileSync("unzip", ["-p", exportPath, betaEntry], { encoding: "utf8" }) === beta.content);
    assert("ZIP excludes foreign document name", !entries.some((entry) => entry.includes(`PAT foreign evidence ${stamp}`)));
  } finally {
    await rm(exportPath, { force: true });
  }

  console.log(`PAT attachment export integration: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});