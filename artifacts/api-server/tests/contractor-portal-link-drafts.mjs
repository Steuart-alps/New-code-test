// Manager portal-link reissue/revocation against queued contractor portal
// reminders, including concurrent approval and dispatch. Runs against the
// disposable database/API with captured contractor mail only:
//   bash tests/run-fresh-schema.sh tests/contractor-portal-link-drafts.mjs
//
// The invariant under test: no contractor email is ever sent with a portal
// link that was not valid at the moment it was sent, and nothing is sent
// without a manager's approval.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import {
  base, db, sql, pool, createTenant, readOutbox, clearOutbox, isoDay,
  decryptTokenPayload, runContractorComplianceReminderJob,
} from "./approval-workflow-fixtures.mjs";

const digest = (token) => createHash("sha256").update(token).digest("hex");
const bearerOf = (url) => url.slice(url.lastIndexOf("/") + 1);
const outbox = process.env.FIXTRACK_TEST_EMAIL_OUTBOX;

test.after(async () => {
  await pool.end();
});

let owner;
test.before(async () => {
  owner = await createTenant("portal-link-drafts");
});

async function portalStatus(url) {
  const response = await fetch(`${base}/contractor-portal/${bearerOf(url)}`);
  await response.arrayBuffer();
  return response.status;
}

async function newContractor(label) {
  const created = await owner.request("POST", "/contractors", {
    name: `Portal drafts ${label}`, email: `portal-drafts-${label}-${Date.now()}@test.local`,
    publicLiabilityExpiry: isoDay(45),
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.id;
}

async function issueLink(contractorId) {
  const issued = await owner.request("POST", `/contractors/${contractorId}/portal-link`, {});
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  return issued.data;
}

/** Run the real scheduler (manager digest discarded) and return each
 *  contractor's pending portal reminder draft. */
async function queueReminders(...contractorIds) {
  await runContractorComplianceReminderJob(async () => {}, async () => {});
  const drafts = new Map();
  for (const contractorId of contractorIds) {
    const rows = (await db.execute(sql`SELECT * FROM contractor_email_queue
      WHERE contractor_id=${contractorId} AND entity_type='contractor_compliance' AND status='pending'`)).rows;
    assert.equal(rows.length, 1, `one pending portal reminder for contractor ${contractorId}`);
    drafts.set(contractorId, rows[0]);
  }
  return drafts;
}

async function draftRow(id) {
  return (await db.execute(sql`SELECT * FROM contractor_email_queue WHERE id=${id}`)).rows[0];
}
const draftLink = (row) => decryptTokenPayload(row.encrypted_token_payload).portal;

async function canonicalHash(contractorId) {
  return (await db.execute(sql`SELECT token_hash FROM contractor_portal_tokens WHERE contractor_id=${contractorId}`)).rows[0]?.token_hash;
}
async function issuanceOf(url) {
  return (await db.execute(sql`SELECT issuance_hash FROM contractor_portal_reminder_tokens
    WHERE token_hash=${digest(bearerOf(url))}`)).rows[0]?.issuance_hash ?? null;
}
async function lastAudit(contractorId, eventType) {
  return (await db.execute(sql`SELECT details FROM contractor_portal_audit_log
    WHERE contractor_id=${contractorId} AND event_type=${eventType} ORDER BY id DESC LIMIT 1`)).rows[0]?.details;
}

const approve = (id) => owner.request("POST", `/fix-track/contractor-email-queue/${id}/approve-and-send`, {});
const reissue = (contractorId) => owner.request("POST", `/contractors/${contractorId}/portal-link`, {});
const revoke = (contractorId) => owner.request("DELETE", `/contractors/${contractorId}/portal-link`);

/** Wait until `count` server queries matching `pattern` are blocked on a lock. */
async function waitForLockWaiters(pattern, count = 1) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type='Lock' AND query ILIKE ${pattern}`)).rows;
    if (rows[0].n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No server query waiting on a lock matching ${pattern}`);
}

/** Wait until some transaction is open (idle, mid-send) holding a lock on the
 *  contractor portal link table: the dispatch guard's share lock. */
async function waitForSendInProgress() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.relation='contractor_portal_tokens'::regclass AND a.state='idle in transaction'`)).rows;
    if (rows[0].n >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The approval never reached the guarded send");
}

/** Hold a queue row's lock from outside the API, so concurrent requests queue
 *  behind it in the order they arrive. */
async function holdDraftLock(id) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM contractor_email_queue WHERE id=$1 FOR UPDATE", [id]);
  return async () => {
    await client.query("COMMIT");
    client.release();
  };
}

/** Swap the captured outbox for a FIFO: the API's mail write then blocks,
 *  mid-send, until `deliver()` reads it. */
async function pauseMail() {
  await rm(outbox, { force: true });
  execFileSync("mkfifo", [outbox]);
  return {
    deliver: async () => (await readFile(outbox, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    restore: async () => {
      // Release a mail write still blocked on the FIFO (an assertion failed
      // before deliver()), so the API can shut down.
      try {
        const fd = openSync(outbox, constants.O_RDONLY | constants.O_NONBLOCK);
        await new Promise((resolve) => setTimeout(resolve, 250));
        closeSync(fd);
      } catch {}
      await rm(outbox, { force: true });
      await writeFile(outbox, "");
    },
  };
}

const emailedLink = (email) => {
  const match = /https?:\/\/[^\s"'<>]+\/contractor-portal\/[A-Za-z0-9-]+/.exec(email.html);
  assert.ok(match, "the email carries a portal link");
  return match[0];
};

test("reissue relinks a pending reminder, which still needs approval and then sends a working link", async () => {
  await clearOutbox();
  const contractorId = await newContractor("reissue-pending");
  await issueLink(contractorId);
  const draft = (await queueReminders(contractorId)).get(contractorId);
  const oldLink = draftLink(draft);
  assert.equal(await portalStatus(oldLink), 200, "the queued reminder link works before the reissue");

  const reissued = await reissue(contractorId);
  assert.equal(reissued.status, 201);
  assert.equal(reissued.data.queuedRemindersRelinked, 1);
  const relinked = await draftRow(draft.id);
  assert.equal(relinked.status, "pending", "the reminder still waits for approval");
  assert.equal(relinked.approved_at, null);
  assert.equal(relinked.body_html, draft.body_html, "the reminder's content is unchanged");
  assert.ok(relinked.body_html.includes("{{PORTAL_URL}}"), "the stored body keeps only the placeholder");
  assert.notEqual(relinked.idempotency_key, draft.idempotency_key, "a relinked reminder gets a new delivery key");
  const newLink = draftLink(relinked);
  assert.ok(!JSON.stringify(relinked).includes(bearerOf(newLink)), "the new bearer exists only encrypted");
  assert.equal(await issuanceOf(newLink), await canonicalHash(contractorId), "the new link is bound to the new issuance");
  assert.equal(await portalStatus(oldLink), 404, "the old queued link stopped working");
  assert.equal(await portalStatus(newLink), 200, "the relinked queued link works");
  assert.deepEqual((await lastAudit(contractorId, "link_issued")).queuedRemindersRelinked, [Number(draft.id)]);
  assert.deepEqual(await readOutbox(), [], "a reissue never sends a queued reminder by itself");

  const approved = await approve(draft.id);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const [email] = await readOutbox();
  assert.equal(emailedLink(email), newLink);
  assert.equal(await portalStatus(emailedLink(email)), 200, "the sent link works");
  assert.equal((await draftRow(draft.id)).status, "sent");
});

test("reissue relinks a reminder that carries the scheduler's own first link", async () => {
  await clearOutbox();
  const contractorId = await newContractor("scheduler-first");
  const draft = (await queueReminders(contractorId)).get(contractorId);
  const oldLink = draftLink(draft);
  assert.equal(await canonicalHash(contractorId), digest(bearerOf(oldLink)), "the scheduler issued the contractor's first link");

  const reissued = await reissue(contractorId);
  assert.equal(reissued.data.queuedRemindersRelinked, 1);
  const newLink = draftLink(await draftRow(draft.id));
  assert.equal(await portalStatus(oldLink), 404);
  assert.equal(await portalStatus(newLink), 200);
  assert.equal(await portalStatus(reissued.data.portalUrl), 200, "the manager's new link works too");
});

test("revoke cancels unsent reminders; approval sends nothing and a later reissue does not revive them", async () => {
  await clearOutbox();
  const contractorId = await newContractor("revoke-pending");
  await issueLink(contractorId);
  const draft = (await queueReminders(contractorId)).get(contractorId);

  assert.equal((await revoke(contractorId)).status, 204);
  const cancelled = await draftRow(draft.id);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.last_error, /revoked/i);
  assert.equal(cancelled.encrypted_token_payload, draft.encrypted_token_payload, "the encrypted payload is kept as it was");
  assert.deepEqual((await lastAudit(contractorId, "link_revoked")).queuedRemindersCancelled, [Number(draft.id)]);

  const approved = await approve(draft.id);
  assert.equal(approved.status, 409);
  assert.equal(approved.data.code, "queue_entry_not_pending");
  assert.deepEqual(await readOutbox(), []);

  const reissued = await reissue(contractorId);
  assert.equal(reissued.data.queuedRemindersRelinked, 0);
  assert.equal((await draftRow(draft.id)).status, "cancelled", "revocation stays final for its drafts");
  assert.equal(await portalStatus(draftLink(draft)), 404);
});

test("a reissue that lands between approval and sending withdraws the approval and sends nothing", async () => {
  await clearOutbox();
  const contractorId = await newContractor("reissue-in-flight");
  await issueLink(contractorId);
  const draft = (await queueReminders(contractorId)).get(contractorId);
  const oldLink = draftLink(draft);

  // Approval queues first on the draft row, then the reissue: the approval
  // claims the draft, and the reissue commits before the claimed send runs.
  const release = await holdDraftLock(draft.id);
  const approval = approve(draft.id);
  await waitForLockWaiters("%UPDATE contractor_email_queue%status='sending'%");
  const reissuing = reissue(contractorId);
  await waitForLockWaiters("%FROM contractor_email_queue%FOR UPDATE%");
  await release();
  const [approved, reissued] = await Promise.all([approval, reissuing]);

  assert.equal(approved.status, 409, JSON.stringify(approved.data));
  assert.equal(approved.data.code, "portal_link_reissued");
  assert.equal(reissued.status, 201);
  assert.equal(reissued.data.queuedRemindersRelinked, 1);
  assert.deepEqual(await readOutbox(), [], "nothing was sent with the replaced link");
  const row = await draftRow(draft.id);
  assert.equal(row.status, "pending", "the reminder waits for a fresh approval");
  assert.equal(row.approved_at, null);
  assert.match(row.last_error, /reissued/i);
  assert.deepEqual((await lastAudit(contractorId, "link_issued")).queuedReminderApprovalsWithdrawn, [Number(draft.id)]);
  assert.equal(await portalStatus(oldLink), 404);

  const reapproved = await approve(draft.id);
  assert.equal(reapproved.status, 200, JSON.stringify(reapproved.data));
  const [email] = await readOutbox();
  assert.equal(await portalStatus(emailedLink(email)), 200, "the re-approved reminder sends the new, working link");
});

test("a revocation that lands between approval and sending cancels the reminder and sends nothing", async () => {
  await clearOutbox();
  const contractorId = await newContractor("revoke-in-flight");
  await issueLink(contractorId);
  const draft = (await queueReminders(contractorId)).get(contractorId);

  const release = await holdDraftLock(draft.id);
  const approval = approve(draft.id);
  await waitForLockWaiters("%UPDATE contractor_email_queue%status='sending'%");
  const revoking = revoke(contractorId);
  await waitForLockWaiters("%FROM contractor_email_queue%FOR UPDATE%");
  await release();
  const [approved, revoked] = await Promise.all([approval, revoking]);

  assert.equal(revoked.status, 204);
  assert.equal(approved.status, 409, JSON.stringify(approved.data));
  assert.equal(approved.data.code, "portal_link_revoked");
  assert.deepEqual(await readOutbox(), []);
  const row = await draftRow(draft.id);
  assert.equal(row.status, "cancelled");
  assert.match(row.last_error, /revoked/i);
});

for (const change of ["reissue", "revoke"]) {
  test(`a ${change} waits for a send already in progress, whose link was valid when sent`, async () => {
    await clearOutbox();
    const contractorId = await newContractor(`${change}-mid-send`);
    await issueLink(contractorId);
    const draft = (await queueReminders(contractorId)).get(contractorId);
    const issuanceBefore = await canonicalHash(contractorId);

    const mail = await pauseMail();
    try {
      const approval = approve(draft.id);
      await waitForSendInProgress();
      let changeSettled = false;
      const changing = (change === "reissue" ? reissue(contractorId) : revoke(contractorId))
        .then((response) => { changeSettled = true; return response; });
      await waitForLockWaiters("%FROM contractor_portal_tokens%FOR UPDATE%");
      assert.equal(changeSettled, false, `the ${change} is held while the email is being sent`);
      const [email] = await mail.deliver();
      const [approved, changed] = await Promise.all([approval, changing]);
      assert.equal(approved.status, 200, JSON.stringify(approved.data));
      assert.equal(await issuanceOf(emailedLink(email)), issuanceBefore,
        "the sent link belonged to the issuance that was current while it was sent");
      assert.equal((await draftRow(draft.id)).status, "sent");
      if (change === "reissue") assert.equal(changed.data.queuedRemindersRelinked, 0, "a sent reminder is not relinked");
      else assert.equal((await lastAudit(contractorId, "link_revoked")).queuedRemindersCancelled, undefined);
      assert.equal(await portalStatus(emailedLink(email)), 404, `the ${change} still takes effect afterwards`);
    } finally {
      await mail.restore();
    }
  });
}

test("racing approvals against reissues and revocations never send an invalid link", async () => {
  await clearOutbox();
  const rounds = [];
  for (let i = 0; i < 8; i++) {
    const contractorId = await newContractor(`race-${i}`);
    await issueLink(contractorId);
    rounds.push({ contractorId, change: i % 2 ? "revoke" : "reissue" });
  }
  const drafts = await queueReminders(...rounds.map((round) => round.contractorId));
  for (const round of rounds) {
    round.draft = drafts.get(round.contractorId);
    round.issuanceBefore = await canonicalHash(round.contractorId);
  }
  await Promise.all(rounds.map(async (round) => {
    const [approved, changed] = await Promise.all([
      approve(round.draft.id),
      round.change === "reissue" ? reissue(round.contractorId) : revoke(round.contractorId),
    ]);
    Object.assign(round, { approved, changed });
  }));

  const emails = await readOutbox();
  for (const round of rounds) {
    const row = await draftRow(round.draft.id);
    const sent = emails.filter((email) => email.idempotencyKey === row.idempotency_key);
    const label = `${round.change} round for queue ${round.draft.id}`;
    if (round.approved.status === 200) {
      assert.equal(sent.length, 1, label);
      assert.equal(row.status, "sent", label);
      const link = emailedLink(sent[0]);
      const issuance = await issuanceOf(link);
      if (round.change === "revoke") {
        // Sent before the revocation took the link row, never after.
        assert.equal(issuance, round.issuanceBefore, label);
        assert.equal((await lastAudit(round.contractorId, "link_revoked")).queuedRemindersCancelled, undefined, label);
      } else if (issuance === round.issuanceBefore) {
        // Sent before the reissue: the reissue saw it as sent.
        assert.equal(round.changed.data.queuedRemindersRelinked, 0, label);
      } else {
        // Approved after the reissue relinked it: sent the new, working link.
        assert.equal(issuance, await canonicalHash(round.contractorId), label);
        assert.equal(await portalStatus(link), 200, label);
      }
    } else {
      assert.equal(round.approved.status, 409, `${label}: ${JSON.stringify(round.approved.data)}`);
      assert.equal(sent.length, 0, `${label}: nothing sent`);
      assert.ok(
        round.change === "reissue"
          ? row.status === "pending" && round.approved.data.code === "portal_link_reissued"
          : row.status === "cancelled" && ["portal_link_revoked", "queue_entry_not_pending"].includes(round.approved.data.code),
        `${label}: ${row.status} ${round.approved.data.code}`,
      );
    }
  }
  assert.equal(emails.length, rounds.filter((round) => round.approved.status === 200).length,
    "every captured email belongs to a successful approval");
});
