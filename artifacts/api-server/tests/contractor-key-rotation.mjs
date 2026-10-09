import assert from "node:assert/strict";
import { randomBytes, createHash, createCipheriv } from "node:crypto";
import test, { after } from "node:test";
import {
  db, sql, pool, createTenant, isoDay, readOutbox, clearOutbox,
  encryptTokenPayload, decryptTokenPayload, tokenPayloadNeedsReencryption,
  reencryptQueuedTokenPayloads,
} from "./approval-workflow-fixtures.mjs";

after(() => pool.end());
const envNames = [
  "SESSION_SECRET", "CONTRACTOR_TOKEN_ENCRYPTION_KEY",
  "CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION", "CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS",
];
const original = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
function restore() {
  for (const name of envNames) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
}
const syntheticKey = () => randomBytes(32).toString("base64url");
const persisted = row => JSON.stringify([
  row.subject, row.body_html, row.body_text, row.email_preview_json,
]);

test("rotated contractor drafts retain their exact approved content and working links", async t => {
  const owner = await createTenant("key-rotation");
  const contractor = await owner.request("POST", "/contractors", {
    name: "Rotation contractor", email: "rotation@test.local",
  });
  assert.equal(contractor.status, 201);
  await clearOutbox();
  const rows = async () => (await db.execute(sql`
    SELECT * FROM contractor_email_queue WHERE client_id=${owner.clientId} ORDER BY id
  `)).rows;

  for (const mode of ["quote", "assign", "portal"]) {
    await t.test(`${mode}: retained session key, dedicated rotation and retirement`, async () => {
      const issue = await owner.request("POST", "/fix-track/issues", {
        title: `Rotation ${mode}`, issueType: "general", location: "Plant room",
        reportedBy: "Facilities", reportedDate: isoDay(), contractorId: contractor.data.id,
      });
      assert.equal(issue.status, 201);
      let row;
      if (mode === "portal") {
        const portal = `https://example.test/contractor-portal/${randomBytes(32).toString("hex")}`;
        const encoded = encryptTokenPayload({ portal });
        const preview = { subject: "Portal reminder", html: '<a href="{{PORTAL_URL}}">Open portal</a>', text: "{{PORTAL_URL}}" };
        row = (await db.execute(sql`
          INSERT INTO contractor_email_queue
            (client_id, issue_id, entity_type, entity_id, contractor_id, mode, email_type,
             to_email, subject, body_html, body_text, email_preview_json,
             encrypted_token_payload, idempotency_key)
          VALUES (${owner.clientId},${issue.data.id},'contractor_compliance',${contractor.data.id},
            ${contractor.data.id},'assign','reminder','rotation@test.local',
            ${preview.subject},${preview.html},${preview.text},${JSON.stringify(preview)}::jsonb,
            ${encoded},${`rotation-portal-${issue.data.id}`})
          RETURNING *
        `)).rows[0];
      } else {
        assert.equal((await owner.request("POST", `/fix-track/issues/${issue.data.id}/request-send`, { mode })).status, 200);
        row = (await rows()).find(row => Number(row.entity_id) === issue.data.id);
      }
      assert.ok(row);
      let approval;
      if (mode === "assign") {
        assert.equal((await owner.request("POST", `/fix-track/issues/${issue.data.id}/approve-send`)).status, 200);
        approval = (await db.execute(sql`SELECT email_request_status, email_approved_by, email_approved_at
          FROM fix_track_issues WHERE id=${issue.data.id}`)).rows[0];
        assert.equal(approval.email_request_status, "approved");
      }
      const payload = decryptTokenPayload(row.encrypted_token_payload);
      const oldSession = syntheticKey();
      const intermediateKey = syntheticKey();
      // Every permitted URL-safe version must work, including object-property names.
      const intermediateVersion = mode === "portal" ? "__proto__" : "rotation-intermediate";
      let oldEncoded;
      try {
        // Generate only synthetic legacy credentials, never change workspace secrets.
        delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY;
        delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION;
        delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS;
        process.env.SESSION_SECRET = oldSession;
        if (mode === "portal") {
          // Before versioned envelopes, drafts used three-part AES-GCM payloads.
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(oldSession).digest(), iv);
          const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
          oldEncoded = [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString("base64url")).join(".");
        } else {
          oldEncoded = encryptTokenPayload(payload);
          assert.match(oldEncoded, /^v2\.session-v1\./);
        }
        await db.execute(sql`UPDATE contractor_email_queue
          SET encrypted_token_payload=${oldEncoded} WHERE id=${row.id}`);

        process.env.SESSION_SECRET = syntheticKey();
        process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY = intermediateKey;
        process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION = intermediateVersion;
        assert.throws(() => decryptTokenPayload(oldEncoded), "a changed session secret alone cannot open an old draft");
        process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify({ "session-v1": oldSession });
        assert.deepEqual(decryptTokenPayload(oldEncoded), payload,
          "an explicitly retained session key takes precedence over the new session secret");
        assert.equal(await reencryptQueuedTokenPayloads(row.id), 1);
        const intermediate = (await rows()).find(current => current.id === row.id);
        assert.ok(intermediate.encrypted_token_payload.startsWith(`v2.${intermediateVersion}.`));
        assert.equal(await reencryptQueuedTokenPayloads(row.id), 0);

        // Remove session-v1 and rotate the dedicated key onto the real server's
        // synthetic current key. Only this fixture is ever migrated.
        restore();
        process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify({
          [intermediateVersion]: intermediateKey,
        });
        assert.deepEqual(decryptTokenPayload(intermediate.encrypted_token_payload), payload);
        assert.throws(() => decryptTokenPayload(oldEncoded), "the retired session key is no longer available");
        assert.equal(await reencryptQueuedTokenPayloads(row.id), 1);
        restore();
        const current = (await rows()).find(current => current.id === row.id);
        assert.equal(tokenPayloadNeedsReencryption(current.encrypted_token_payload), false);
        assert.deepEqual(decryptTokenPayload(current.encrypted_token_payload), payload);
        assert.equal(persisted(current), persisted(row), "rotation does not change reviewed content");
        assert.equal(current.status, row.status);
        assert.equal(current.idempotency_key, row.idempotency_key);
        assert.throws(() => decryptTokenPayload(intermediate.encrypted_token_payload),
          "retired dedicated keys cannot open obsolete ciphertext");
        for (const raw of Object.values(payload)) {
          assert.ok(!persisted(current).includes(raw));
          assert.ok(!current.encrypted_token_payload.includes(raw));
        }
      } finally {
        restore();
      }

      const listed = await owner.request("GET", "/fix-track/contractor-email-queue");
      assert.equal(listed.status, 200);
      const preview = listed.data.find(draft => draft.id === row.id)?.emailPreviewJson;
      assert.ok(preview);
      for (const raw of Object.values(payload)) assert.ok(JSON.stringify(preview).includes(raw));
      const before = (await readOutbox()).length;
      if (approval) {
        assert.deepEqual((await db.execute(sql`SELECT email_request_status, email_approved_by, email_approved_at
          FROM fix_track_issues WHERE id=${issue.data.id}`)).rows[0], approval,
        "rotation preserves an existing manager approval");
      }
      const sent = await owner.request("POST", mode === "assign"
        ? `/fix-track/issues/${issue.data.id}/send-to-contractor`
        : `/fix-track/contractor-email-queue/${row.id}/approve-and-send`);
      assert.equal(sent.status, 200, JSON.stringify(sent.data));
      const emails = await readOutbox();
      assert.equal(emails.length, before + 1);
      const delivered = emails.at(-1);
      assert.equal(delivered.subject, preview.subject);
      assert.equal(delivered.html, preview.html);
      assert.equal(delivered.text, preview.text);
      for (const raw of Object.values(payload)) assert.ok(JSON.stringify(delivered).includes(raw));
      assert.equal((await owner.request("POST", `/fix-track/contractor-email-queue/${row.id}/approve-and-send`)).status, 409);
      assert.equal((await readOutbox()).length, before + 1, "rotation does not duplicate dispatch");
    });
  }

  await t.test("missing retained key fails migration without damaging a pending draft", async () => {
    const key = syntheticKey();
    let unreadable;
    try {
      process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY = key;
      process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION = "unavailable-key";
      unreadable = encryptTokenPayload({ quote: randomBytes(32).toString("hex") });
    } finally {
      restore();
    }
    const template = (await rows())[0];
    const source = (await db.execute(sql`
      INSERT INTO contractor_email_queue
        (client_id,issue_id,entity_type,entity_id,contractor_id,mode,email_type,to_email,
         subject,body_html,body_text,email_preview_json,encrypted_token_payload,idempotency_key)
      SELECT client_id,issue_id,entity_type,entity_id,contractor_id,mode,email_type,to_email,
        subject,body_html,body_text,email_preview_json,encrypted_token_payload,${`missing-key-${template.id}`}
      FROM contractor_email_queue WHERE id=${template.id} RETURNING *
    `)).rows[0];
    assert.equal(source.status, "pending");
    await db.execute(sql`UPDATE contractor_email_queue
      SET encrypted_token_payload=${unreadable} WHERE id=${source.id}`);
    await assert.rejects(reencryptQueuedTokenPayloads(source.id), /No contractor token encryption key/);
    const unchanged = (await rows()).find(row => row.id === source.id);
    assert.equal(unchanged.encrypted_token_payload, unreadable);
    assert.equal(unchanged.status, source.status);
    // Restore this fixture so the database remains readable even after assertions.
    await db.execute(sql`UPDATE contractor_email_queue
      SET encrypted_token_payload=${source.encrypted_token_payload} WHERE id=${source.id}`);
  });
});