// Integration coverage for DocTrack's upload finalization and private-object ACL.
// The provider-backed run is tests/run-storage-happy-path.sh (dedicated test
// bucket); tests/run-doc-track-object-acl.sh runs the app-level checks only.
import assert from "node:assert/strict";
import { skipWhenStorageUnavailable } from "./storage-test-availability.mjs";
import { appDownloadPath, createRun, sha256 } from "./storage-acl-session.mjs";

const run = createRun("doc-acl");

async function main() {
  const owner = await run.registerTenant("owner");
  // A second signed-in user of the uploading client (not the uploader).
  const colleague = await run.addSameClientUser(owner, "colleague");

  let response = await owner.request("POST", "/doc-track/documents/request-upload", {
    name: "tenant-policy.pdf",
    contentType: "application/pdf",
  });
  if (skipWhenStorageUnavailable(response, "DocTrack object ACL integration")) return;
  assert.equal(response.status, 200, "request owner upload URL");
  const { uploadUrl, objectPath } = response.data;
  assert.equal(typeof uploadUrl, "string", "upload URL returned");
  assert.equal(typeof objectPath, "string", "object path returned");
  assert.equal(objectPath.startsWith(`/objects/uploads/tenant-${owner.clientId}/`), true, "upload reserved under the owner's tenant");

  // A signing request reserves a name only; it does not create an object or ACL.
  response = await owner.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 404, "unuploaded presigned PUT path is explicitly absent");

  const uploaded = Buffer.from(`%PDF-1.4\nDocTrack ACL coverage ${run.runId}\n`);
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: uploaded,
  });
  assert.equal(put.ok, true, "upload document");

  // The object now exists, but remains unreadable until DocTrack finalizes it.
  await run.assertProviderHasNoAcl(objectPath);
  response = await owner.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 403, "uploaded but unfinalized object has no tenant ACL");

  const otherTenant = await run.registerTenant("other");
  response = await otherTenant.request("POST", "/doc-track/documents", {
    title: "Claimed unfinalized policy",
    category: "policy",
    fileName: "tenant-policy.pdf",
    mimeType: "application/pdf",
    objectPath,
  });
  assert.equal(response.status, 403, "other tenant cannot claim an unfinalized reserved upload");

  response = await owner.request("POST", "/doc-track/documents", {
    title: "Tenant policy",
    category: "policy",
    fileName: "tenant-policy.pdf",
    mimeType: "application/pdf",
    objectPath,
  });
  assert.equal(response.status, 201, "finalize document and assign tenant ACL");
  const documentId = response.data.id;

  // Provider metadata: owner is the uploading client, visibility private.
  await run.assertProviderAcl(objectPath, { ownerClientId: owner.clientId, bytes: uploaded });

  response = await owner.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 200, "same tenant can read finalized document");
  assert.equal(sha256(response.bytes), sha256(uploaded), "owner reads the uploaded bytes");
  response = await owner.request("GET", `/doc-track/documents/${documentId}/download-url`);
  assert.equal(response.status, 200, "same tenant receives finalized document download URL");
  assert.equal(typeof response.data?.downloadUrl, "string", "download URL is returned");

  // Another logged-in user of the same client gets exactly the uploaded bytes.
  response = await colleague.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 200, "same-client colleague can read the finalized object");
  assert.equal(sha256(response.bytes), sha256(uploaded), "colleague object read matches the uploaded bytes");
  response = await colleague.request("GET", `/doc-track/documents/${documentId}/download-url`);
  assert.equal(response.status, 200, "same-client colleague receives a download URL");
  response = await colleague.request("GET", appDownloadPath(response.data.downloadUrl));
  assert.equal(response.status, 200, "colleague downloads through the app link");
  assert.equal(sha256(response.bytes), sha256(uploaded), "colleague download matches the uploaded bytes");

  response = await otherTenant.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 403, "other tenant cannot read finalized document");
  response = await otherTenant.request("GET", `/doc-track/documents/${documentId}/download-url`);
  assert.equal(response.status, 404, "other tenant cannot obtain a download URL for the owner's record");
  response = await otherTenant.request("POST", "/doc-track/documents", {
    title: "Claimed foreign policy",
    category: "policy",
    fileName: "tenant-policy.pdf",
    mimeType: "application/pdf",
    objectPath,
  });
  assert.equal(response.status, 403, "other tenant cannot finalize a foreign object");

  response = await owner.request("POST", "/doc-track/documents", {
    title: "Missing document",
    category: "policy",
    fileName: "missing.pdf",
    mimeType: "application/pdf",
    objectPath: "/objects/uploads/does-not-exist",
  });
  assert.equal(response.status, 404, "finalizing a nonexistent object fails explicitly");

  console.log("DocTrack object ACL coverage passed");
}

let failure;
try { await main(); } catch (error) { failure = error; }
try { await run.cleanup(); } catch (error) {
  if (failure) console.error(error); else failure = error;
}
if (failure) throw failure;
