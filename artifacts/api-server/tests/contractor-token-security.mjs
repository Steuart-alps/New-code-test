import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import {
  base, db, sql, pool, createTenant, readOutbox, clearOutbox,
  isoDay, runRuntimeMigrations, decryptTokenPayload,
} from "./approval-workflow-fixtures.mjs";

after(() => pool.end());
const digest = token => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("hex");
const rendered = row => [row.subject, row.body_html, row.body_text, JSON.stringify(row.email_preview_json)].join("\n");

async function publicRequest(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, text: await response.text() };
}

test("new and migrated contractor credentials are digest-only without changing issued links", async t => {
  const owner = await createTenant("token-security");
  const contractor = await owner.request("POST", "/contractors", {
    name: "Private token fixture contractor", email: "token-security@test.local",
  });
  assert.equal(contractor.status, 201);
  async function issue(label) {
    const result = await owner.request("POST", "/fix-track/issues", {
      title: `Token security ${label}`, issueType: "general", location: "Plant room",
      reportedBy: "Facilities", reportedDate: isoDay(), contractorId: contractor.data.id,
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.id;
  }
  async function queueRows() {
    return (await db.execute(sql`
      SELECT * FROM contractor_email_queue WHERE client_id=${owner.clientId} ORDER BY id
    `)).rows;
  }
  await clearOutbox();

  await t.test("new quote and action links never persist plaintext lookup tokens or rendered bearers", async () => {
    for (const mode of ["quote", "assign"]) {
      const issueId = await issue(`new-${mode}`);
      const requested = await owner.request("POST", `/fix-track/issues/${issueId}/request-send`, { mode });
      assert.equal(requested.status, 200, JSON.stringify(requested.data));
      const list = await owner.request("GET", "/fix-track/contractor-email-queue");
      assert.equal(list.status, 200);
      const draft = list.data.find(row => row.entityId === issueId);
      assert.ok(draft);
      const stored = (await queueRows()).find(row => Number(row.id) === draft.id);
      const payload = decryptTokenPayload(stored.encrypted_token_payload);
      assert.equal(stored.quote_token, null);
      for (const token of Object.values(payload)) {
        assert.match(token, /^[a-f0-9]{64}$/);
        assert.ok(!rendered(stored).includes(token));
        assert.ok(!stored.encrypted_token_payload.includes(token));
      }
      if (mode === "quote") {
        assert.equal(stored.quote_token_hash, digest(payload.quote));
        assert.notEqual(stored.quote_token_hash, payload.quote);
        assert.equal((await publicRequest(`/fix-track/quotes/public/${payload.quote}`)).status, 404,
          "an unapproved quote link cannot be used");
      } else {
        const actions = (await db.execute(sql`
          SELECT token, token_hash, action FROM fix_track_action_tokens WHERE issue_id=${issueId}
        `)).rows;
        assert.equal(actions.length, 2);
        for (const row of actions) {
          assert.equal(row.token, null);
          assert.equal(row.token_hash, digest(payload[row.action]));
          assert.notEqual(row.token_hash, payload[row.action]);
        }
      }
      const expectedSubject = mode === "quote" ? `Reviewed quote ${payload.quote}` : draft.emailPreviewJson.subject;
      const sent = await owner.request("POST",
        `/fix-track/contractor-email-queue/${draft.id}/${mode === "quote" ? "edit-and-send" : "approve-and-send"}`,
        mode === "quote" ? { subject: expectedSubject, bodyText: draft.emailPreviewJson.text } : undefined);
      assert.equal(sent.status, 200, JSON.stringify(sent.data));
      assert.equal(sent.data.subject, expectedSubject);
      const delivered = (await readOutbox()).at(-1);
      assert.equal(delivered.subject, expectedSubject);
      assert.equal(delivered.html, sent.data.bodyHtml);
      const storedSent = (await queueRows()).find(row => Number(row.id) === draft.id);
      for (const token of Object.values(payload)) assert.ok(!rendered(storedSent).includes(token),
        "sending an edited subject does not persist its working bearer");
      if (mode === "quote") {
        assert.equal((await publicRequest(`/fix-track/quotes/public/${payload.quote}`)).status, 200);
        assert.equal((await publicRequest(`/fix-track/quotes/public/${digest(payload.quote)}`)).status, 404,
          "a database digest cannot be substituted for the bearer");
      } else {
        for (const token of Object.values(payload)) {
          assert.equal((await publicRequest(`/fix-track/action/${token}`)).status, 200);
          assert.equal((await publicRequest(`/fix-track/action/${digest(token)}`)).status, 404);
        }
      }
    }
  });

  const quoteIssue = await issue("legacy-quote");
  const actionIssue = await issue("legacy-assignment");
  const quoteToken = newToken();
  const expiredQuoteToken = newToken();
  const bookedToken = randomUUID(); // Older UUID links must also survive conversion.
  const completedToken = newToken();
  const expiredToken = newToken();
  const usedToken = newToken();
  const revokedToken = newToken();
  const legacyActions = [
    [bookedToken, "booked", false, false, false],
    [completedToken, "completed", false, false, false],
    [expiredToken, "booked", true, false, false],
    [usedToken, "completed", false, true, false],
    [revokedToken, "booked", false, false, true],
  ];
  for (const [token, action, expired, used, revoked] of legacyActions) {
    await db.execute(sql`
      INSERT INTO fix_track_action_tokens
        (token, token_hash, issue_id, client_id, contractor_id, action, expires_at, used_at, revoked_at)
      VALUES (${token}, NULL, ${actionIssue}, ${owner.clientId}, ${contractor.data.id}, ${action},
        ${expired ? sql`now()-interval '1 day'` : sql`now()+interval '10 days'`},
        ${used ? sql`now()-interval '1 hour'` : null}, ${revoked ? sql`now()-interval '1 hour'` : null})
    `);
  }
  const subject = `Legacy booking ${bookedToken}`;
  const html = `<a href="https://test.local/api/fix-track/action/${bookedToken}">Book</a>
    <a href="https://test.local/api/fix-track/action/${completedToken}">Complete</a>`;
  const text = `Book /api/fix-track/action/${bookedToken}\nComplete /api/fix-track/action/${completedToken}`;
  const oldAssignment = await db.execute(sql`
    INSERT INTO contractor_email_queue
      (client_id, entity_type, entity_id, issue_id, contractor_id, email_type, mode, status,
       to_email, subject, body_html, body_text, email_preview_json, idempotency_key)
    VALUES (${owner.clientId}, 'fix_track', ${actionIssue}, ${actionIssue}, ${contractor.data.id},
      'assignment', 'assign', 'pending', 'token-security@test.local', ${subject}, ${html}, ${text},
      ${JSON.stringify({ subject, html, text })}::jsonb, ${`legacy-assignment-${randomUUID()}`})
    RETURNING id
  `);
  for (const [token, expired] of [[quoteToken, false], [expiredQuoteToken, true]]) {
    await db.execute(sql`
      INSERT INTO contractor_email_queue
        (client_id, entity_type, entity_id, issue_id, contractor_id, email_type, mode, status,
         to_email, subject, body_html, body_text, email_preview_json, quote_token,
         quote_token_expires_at, idempotency_key)
      VALUES (${owner.clientId}, 'fix_track', ${quoteIssue}, ${quoteIssue}, ${contractor.data.id},
        'quote_request', 'quote', 'sent', 'token-security@test.local', ${`Legacy quote ${token}`},
        ${`<a href="https://test.local/contractor-quote/${token}">Quote</a>`},
        ${`Quote /contractor-quote/${token}`}, ${JSON.stringify({ html: `/contractor-quote/${token}`, text: token })}::jsonb,
        ${token}, ${expired ? sql`now()-interval '1 day'` : sql`now()+interval '10 days'`},
        ${`legacy-quote-${randomUUID()}`})
    `);
  }
  const actionSnapshot = async () => (await db.execute(sql`
    SELECT id, token_hash, expires_at, used_at, revoked_at FROM fix_track_action_tokens
    WHERE client_id=${owner.clientId} ORDER BY id
  `)).rows;
  const quoteSnapshot = async () => (await db.execute(sql`
    SELECT id, status, quote_token_expires_at FROM contractor_email_queue
    WHERE client_id=${owner.clientId} AND mode='quote' ORDER BY id
  `)).rows;
  const beforeActions = await actionSnapshot();
  const beforeQuotes = await quoteSnapshot();
  const issuedAssignment = (await queueRows()).find(row => row.mode === "assign");
  const barePayload = decryptTokenPayload(issuedAssignment.encrypted_token_payload);
  const bareSubject = `Legacy reference ${barePayload.booked}`;
  // A legacy edited draft may carry an encrypted payload while duplicating
  // its credential as bare text. URL-only migration detection misses it.
  await db.execute(sql`
    INSERT INTO contractor_email_queue
      (client_id, entity_type, entity_id, issue_id, contractor_id, email_type, mode,
       to_email, subject, body_html, body_text, email_preview_json, encrypted_token_payload, idempotency_key)
    VALUES (${owner.clientId}, 'fix_track', ${issuedAssignment.issue_id}, ${issuedAssignment.issue_id},
      ${contractor.data.id}, 'assignment', 'assign', 'token-security@test.local',
      ${bareSubject}, ${`<p>${barePayload.completed}</p>`}, ${barePayload.booked},
      ${JSON.stringify({ subject: bareSubject, text: barePayload.completed })}::jsonb,
      ${issuedAssignment.encrypted_token_payload}, ${`legacy-bare-reference-${randomUUID()}`})
  `);

  await t.test("the real startup migration scrubs legacy credentials while preserving expiry, use and revocation", async () => {
    // The disposable API is idle and all background schedulers are disabled.
    // Run the exact startup migration with one writer, never a shared database.
    await runRuntimeMigrations();
    const afterActions = await actionSnapshot();
    assert.deepEqual(afterActions.map(({ token_hash, ...state }) => state),
      beforeActions.map(({ token_hash, ...state }) => state));
    assert.deepEqual(await quoteSnapshot(), beforeQuotes);
    const rawActions = (await db.execute(sql`
      SELECT token, token_hash FROM fix_track_action_tokens WHERE client_id=${owner.clientId}
    `)).rows;
    assert.ok(rawActions.every(row => row.token === null));
    for (const [token] of legacyActions) assert.ok(rawActions.some(row => row.token_hash === digest(token)));
    const queues = await queueRows();
    const allLegacyTokens = [...legacyActions.map(([token]) => token), quoteToken, expiredQuoteToken, ...Object.values(barePayload)];
    for (const row of queues) {
      assert.equal(row.quote_token, null);
      for (const token of allLegacyTokens) assert.ok(!rendered(row).includes(token),
        "migration removes working credentials from URLs and bare-text references");
    }
    for (const token of [quoteToken, expiredQuoteToken]) {
      const row = queues.find(row => row.quote_token_hash === digest(token));
      assert.ok(row);
      assert.equal(decryptTokenPayload(row.encrypted_token_payload).quote, token);
    }
    const pending = await owner.request("GET", "/fix-track/contractor-email-queue");
    const preview = pending.data.find(row => row.id === Number(oldAssignment.rows[0].id));
    assert.deepEqual(preview.emailPreviewJson, { subject, html, text },
      "the authorised preview restores the exact legacy email and links");
    assert.equal((await owner.request("POST",
      `/fix-track/contractor-email-queue/${oldAssignment.rows[0].id}/approve-and-send`)).status, 200);
    const delivered = (await readOutbox()).at(-1);
    assert.deepEqual({ subject: delivered.subject, html: delivered.html, text: delivered.text }, { subject, html, text });
    await runRuntimeMigrations();
    assert.deepEqual(await actionSnapshot(), afterActions, "repeated startup does not re-hash hashes or rotate links");
    assert.deepEqual(await quoteSnapshot(), beforeQuotes);
  });

  await t.test("migrated links retain expiry and one-time use, and digests grant no access", async () => {
    assert.equal((await publicRequest(`/fix-track/action/${completedToken}`)).status, 200);
    assert.equal((await publicRequest(`/fix-track/action/${expiredToken}`)).status, 410);
    assert.equal((await publicRequest(`/fix-track/action/${expiredToken}/booked`, "POST")).status, 410);
    const used = await publicRequest(`/fix-track/action/${usedToken}`);
    assert.equal(used.status, 200);
    assert.ok(used.text.includes("Already recorded"));
    assert.equal((await publicRequest(`/fix-track/action/${usedToken}`, "POST", {})).status, 409);
    assert.equal((await publicRequest(`/fix-track/action/${revokedToken}`)).status, 404);
    assert.equal((await publicRequest(`/fix-track/action/${revokedToken}/booked`, "POST")).status, 400);
    assert.equal((await publicRequest(`/fix-track/action/${digest(bookedToken)}`)).status, 404);
    const bookings = await Promise.all([
      publicRequest(`/fix-track/action/${bookedToken}/booked`, "POST"),
      publicRequest(`/fix-track/action/${bookedToken}/booked`, "POST"),
    ]);
    assert.deepEqual(bookings.map(row => row.status).sort(), [200, 409]);
    assert.equal((await publicRequest(`/fix-track/action/${bookedToken}/booked`, "POST")).status, 409);
    assert.equal((await publicRequest(`/fix-track/quotes/public/${expiredQuoteToken}`)).status, 404);
    assert.equal((await publicRequest(`/fix-track/quotes/public/${expiredQuoteToken}`, "POST", { poundsPrice: 10 })).status, 404);
    assert.equal((await publicRequest(`/fix-track/quotes/public/${digest(quoteToken)}`)).status, 404);
    assert.equal((await publicRequest(`/fix-track/quotes/public/${quoteToken}`)).status, 200);
    const quotes = await Promise.all([
      publicRequest(`/fix-track/quotes/public/${quoteToken}`, "POST", { poundsPrice: 12.34 }),
      publicRequest(`/fix-track/quotes/public/${quoteToken}`, "POST", { poundsPrice: 12.34 }),
    ]);
    assert.deepEqual(quotes.map(row => row.status).sort(), [201, 409]);
    const submissions = (await db.execute(sql`
      SELECT price_pence FROM fix_track_quote_submissions
      WHERE queue_id=(SELECT id FROM contractor_email_queue WHERE quote_token_hash=${digest(quoteToken)})
    `)).rows;
    assert.deepEqual(submissions.map(row => row.price_pence), [1234]);
  });
});