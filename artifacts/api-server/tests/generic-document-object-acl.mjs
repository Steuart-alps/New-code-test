// Regression coverage for generic client document upload ownership.
// This is deliberately separate from DocTrack because the customer Documents
// page uses /storage/uploads/request-url and /documents directly.
import assert from "node:assert/strict";

const BASE = process.env.API_BASE || "http://localhost:8080/api";

function client() {
  let cookie = "";
  return async function request(method, path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const contentType = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      data: contentType.includes("application/json")
        ? await response.json()
        : null,
      text: contentType.includes("application/json")
        ? null
        : await response.text(),
    };
  };
}

async function registerAndLogin(request, label) {
  const email = `generic-doc-${label}-${Date.now()}-${Math.random()}@test.local`;
  let response = await request("POST", "/auth/register", {
    name: `Generic Document ${label}`,
    email,
    password: "password-123",
  });
  assert.equal(response.status, 200, `${label}: register`);
  assert.equal(typeof response.data?.verificationToken, "string", `${label}: verification token`);

  response = await request(
    "GET",
    `/auth/verify-email?token=${encodeURIComponent(response.data.verificationToken)}`,
  );
  assert.equal(response.status, 200, `${label}: verify email`);

  response = await request("POST", "/auth/login", { email, password: "password-123" });
  assert.equal(response.status, 200, `${label}: login`);
}

const owner = client();
const other = client();
await registerAndLogin(owner, "owner");
await registerAndLogin(other, "other");

let response = await owner("POST", "/storage/uploads/request-url", {
  name: "tenant-policy.pdf",
  size: 37,
  contentType: "application/pdf",
});
assert.equal(response.status, 200, "owner receives a presigned upload URL");
const { uploadURL, objectPath } = response.data;
assert.equal(typeof uploadURL, "string", "upload URL returned");
assert.equal(typeof objectPath, "string", "tenant object path returned");

// A reserved path is not readable before the direct upload creates an object.
response = await owner("GET", `/storage${objectPath}`);
assert.equal(response.status, 404, "reserved but unuploaded object is absent");

const put = await fetch(uploadURL, {
  method: "PUT",
  headers: { "Content-Type": "application/pdf" },
  body: Buffer.from("%PDF-1.4\nGeneric document ACL coverage\n"),
});
assert.equal(put.ok, true, "direct object upload succeeds");

// Upload completion alone must not grant access; document registration is the
// ACL finalization boundary.
response = await owner("GET", `/storage${objectPath}`);
assert.equal(response.status, 403, "uploaded but unregistered object remains private");

// The other tenant cannot attach the owner's object to its own document row.
response = await other("POST", "/documents", {
  name: "stolen-policy",
  objectPath,
  fileSize: 37,
  mimeType: "application/pdf",
});
assert.equal(response.status, 403, "foreign tenant cannot register owner's object");

response = await owner("POST", "/documents", {
  name: "tenant-policy",
  objectPath,
  fileSize: 37,
  mimeType: "application/pdf",
});
assert.equal(response.status, 201, "owner registers and finalizes its document");
const documentId = response.data?.id;
assert.equal(Number.isInteger(documentId), true, "registered document has an id");

response = await owner("GET", `/storage${objectPath}`);
assert.equal(response.status, 200, "owner can read finalized object");
response = await owner("GET", `/documents/${documentId}/download`);
assert.equal(response.status, 200, "owner can download its document");
assert.match(response.text ?? "", /Generic document ACL coverage/, "download contains uploaded content");

// The database tenant predicate blocks the foreign document ID, and the
// storage ACL independently blocks direct object access.
response = await other("GET", `/documents/${documentId}/download`);
assert.equal(response.status, 404, "foreign tenant cannot download owner's document record");
response = await other("GET", `/storage${objectPath}`);
assert.equal(response.status, 403, "foreign tenant cannot read owner's finalized object");

// A nonexistent object must never create a database document row.
response = await owner("POST", "/documents", {
  name: "missing-policy",
  objectPath: "/objects/uploads/does-not-exist",
  mimeType: "application/pdf",
});
assert.equal(response.status, 400, "missing object registration is rejected");

console.log("Generic document object ACL coverage passed");