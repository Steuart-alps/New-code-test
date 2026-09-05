// Integration coverage for DocTrack's upload finalization and private-object ACL.
// Run against the API/object-storage test environment, like the other route tests.
import assert from "node:assert/strict";

const BASE = process.env.API_BASE || "http://localhost:8080/api";

function client() {
  let cookie = "";
  return async function request(method, path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return {
      status: response.status,
      data: (response.headers.get("content-type") ?? "").includes("application/json")
        ? await response.json()
        : null,
    };
  };
}

async function registerAndLogin(request, label) {
  const email = `doc-acl-${label}-${Date.now()}-${Math.random()}@test.local`;
  let response = await request("POST", "/auth/register", {
    name: `Doc ACL ${label}`, email, password: "password-123",
  });
  assert.equal(response.status, 200, "register tenant");
  assert.equal(typeof response.data?.verificationToken, "string", "test verification token");
  response = await request(
    "GET",
    `/auth/verify-email?token=${encodeURIComponent(response.data.verificationToken)}`,
  );
  assert.equal(response.status, 200, "verify tenant");
  response = await request("POST", "/auth/login", { email, password: "password-123" });
  assert.equal(response.status, 200, "log in tenant");
}

const owner = client();
await registerAndLogin(owner, "owner");

let response = await owner("POST", "/doc-track/documents/request-upload", {
  name: "tenant-policy.pdf",
  contentType: "application/pdf",
});
assert.equal(response.status, 200, "request owner upload URL");
const { uploadUrl, objectPath } = response.data;

// A signing request reserves a name only; it does not create an object or ACL.
response = await owner("GET", `/storage${objectPath}`);
assert.equal(response.status, 404, "unuploaded presigned PUT path is explicitly absent");

const put = await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "application/pdf" },
  body: Buffer.from("%PDF-1.4\nDocTrack ACL coverage\n"),
});
assert.equal(put.ok, true, "upload document");

// The object now exists, but remains unreadable until DocTrack finalizes it.
response = await owner("GET", `/storage${objectPath}`);
assert.equal(response.status, 403, "uploaded but unfinalized object has no tenant ACL");

const otherTenant = client();
await registerAndLogin(otherTenant, "other");
response = await otherTenant("POST", "/doc-track/documents", {
  title: "Claimed unfinalized policy",
  category: "policy",
  fileName: "tenant-policy.pdf",
  mimeType: "application/pdf",
  objectPath,
});
assert.equal(response.status, 403, "other tenant cannot claim an unfinalized reserved upload");

response = await owner("POST", "/doc-track/documents", {
  title: "Tenant policy",
  category: "policy",
  fileName: "tenant-policy.pdf",
  mimeType: "application/pdf",
  objectPath,
});
assert.equal(response.status, 201, "finalize document and assign tenant ACL");
const documentId = response.data.id;

response = await owner("GET", `/storage${objectPath}`);
assert.equal(response.status, 200, "same tenant can read finalized document");
response = await owner("GET", `/doc-track/documents/${documentId}/download-url`);
assert.equal(response.status, 200, "same tenant receives finalized document download URL");
assert.equal(typeof response.data?.downloadUrl, "string", "download URL is returned");

response = await otherTenant("GET", `/storage${objectPath}`);
assert.equal(response.status, 403, "other tenant cannot read finalized document");
response = await otherTenant("POST", "/doc-track/documents", {
  title: "Claimed foreign policy",
  category: "policy",
  fileName: "tenant-policy.pdf",
  mimeType: "application/pdf",
  objectPath,
});
assert.equal(response.status, 403, "other tenant cannot finalize a foreign object");

response = await owner("POST", "/doc-track/documents", {
  title: "Missing document",
  category: "policy",
  fileName: "missing.pdf",
  mimeType: "application/pdf",
  objectPath: "/objects/uploads/does-not-exist",
});
assert.equal(response.status, 404, "finalizing a nonexistent object fails explicitly");

console.log("DocTrack object ACL coverage passed");