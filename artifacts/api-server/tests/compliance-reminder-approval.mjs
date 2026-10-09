import test from "node:test";
import assert from "node:assert/strict";
import {
  db,
  sql,
  pool,
  runReminderJob,
  createTenant,
  createUser,
  readOutbox,
  clearOutbox,
  isoDay,
} from "./approval-workflow-fixtures.mjs";

test.after(async () => {
  await pool.end();
});

test("compliance reminder approval is atomic, scoped, and dispatches the edited preview", async () => {
  await clearOutbox();
  const owner = await createTenant("compliance-reminder-owner");
  const foreign = await createTenant("compliance-reminder-foreign");

  const department = async (clientId, name) => {
    const result = await db.execute(sql`
      INSERT INTO departments (client_id, name) VALUES (${clientId}, ${name}) RETURNING id
    `);
    return Number(result.rows[0].id);
  };
  const ownerDept = await department(owner.clientId, "Reminder Approval Department");
  const otherDept = await department(owner.clientId, "Other Reminder Department");
  const foreignDept = await department(foreign.clientId, "Foreign Reminder Department");

  const managerA = await createUser(owner, {
    name: "Reminder department manager",
    role: "client_staff",
    isMaintenanceManager: true,
    departmentId: ownerDept,
  });
  const managerB = await createUser(owner, {
    name: "Other department manager",
    role: "client_staff",
    isMaintenanceManager: true,
    departmentId: otherDept,
  });
  const staff = await createUser(owner, {
    name: "Reminder department staff",
    role: "client_staff",
    departmentId: ownerDept,
  });
  const foreignManager = await createUser(foreign, {
    name: "Foreign department manager",
    role: "client_staff",
    isMaintenanceManager: true,
    departmentId: foreignDept,
  });

  const site = await owner.request("POST", "/sites", {
    name: "Reminder department site", departmentId: ownerDept, seedStarterChecks: false,
  });
  assert.equal(site.status, 201);
  const makeItem = async (label, departmentId, siteId = null) => {
    const contractor = await db.execute(sql`
      INSERT INTO contractors (client_id, name, email)
      VALUES (${owner.clientId}, ${`Reminder contractor ${label}`}, ${`reminder-${label}@test.local`})
      RETURNING id
    `);
    const contractorId = Number(contractor.rows[0].id);
    const item = await db.execute(sql`
      INSERT INTO compliance_items
        (client_id, department_id, site_id, title, status, contractor_id, due_date, lead_time_days)
      VALUES (${owner.clientId}, ${departmentId}, ${siteId}, ${`Approval reminder ${label}`}, 'pending',
        ${contractorId}, ${isoDay(0)}::date, 0)
      RETURNING id
    `);
    return Number(item.rows[0].id);
  };

  // Site-scoped items may have no explicit item department. The queue must
  // inherit the site's department rather than become visible to all managers.
  const currentItemId = await makeItem("cycle", null, site.data.id);
  const failQueueItemId = await makeItem("queue-failure", ownerDept);
  const failUpdateItemId = await makeItem("item-failure", ownerDept);

  // Only the cycle fixture is due while checking scheduler concurrency/retries.
  const setEligibleItem = async (id) => {
    await db.execute(sql`UPDATE compliance_items SET notification_sent_at=NULL WHERE id=${id}`);
  };
  const suppressOtherItems = async (...ids) => {
    for (const id of ids) {
      await db.execute(sql`UPDATE compliance_items SET notification_sent_at=now() WHERE id=${id}`);
    }
  };
  await suppressOtherItems(failQueueItemId, failUpdateItemId);

  const concurrentRuns = await Promise.all([runReminderJob(), runReminderJob()]);
  assert.equal(concurrentRuns.reduce((sum, result) => sum + result.queued, 0), 1,
    "concurrent due-cycle jobs queue one reminder");
  let queueRows = await db.execute(sql`
    SELECT id, status, department_id, subject, body_html, body_text, email_preview_json,
      encrypted_token_payload, idempotency_key
    FROM contractor_email_queue
    WHERE entity_type='compliance' AND entity_id=${currentItemId} AND status='pending'
  `);
  assert.equal(queueRows.rows.length, 1, "exactly one pending reminder row exists");
  assert.equal(Number(queueRows.rows[0].department_id), ownerDept,
    "the reminder queue row carries the compliance item's department");

  let itemState = await db.execute(sql`SELECT schedule_token FROM compliance_items WHERE id=${currentItemId}`);
  const originalToken = itemState.rows[0].schedule_token;
  assert.ok(originalToken, "the first successful queue claim issues a schedule token");
  const storedQueue = queueRows.rows[0];
  const serializedDraft = [
    storedQueue.subject,
    storedQueue.body_html,
    storedQueue.body_text,
    JSON.stringify(storedQueue.email_preview_json),
  ].join("\n");
  assert.ok(!serializedDraft.includes(originalToken), "raw schedule bearer is absent from all queue drafts");
  assert.ok(serializedDraft.includes("{{BOOKED_TOKEN}}"), "queued schedule link uses the encrypted-token placeholder");

  await runReminderJob();
  itemState = await db.execute(sql`SELECT schedule_token FROM compliance_items WHERE id=${currentItemId}`);
  assert.equal(itemState.rows[0].schedule_token, originalToken,
    "retrying the same due cycle preserves its originally issued token");
  queueRows = await db.execute(sql`
    SELECT id FROM contractor_email_queue
    WHERE entity_type='compliance' AND entity_id=${currentItemId} AND status='pending'
  `);
  assert.equal(queueRows.rows.length, 1, "same-cycle retry leaves exactly one pending queue row");
  await suppressOtherItems(currentItemId);

  // A queue insertion failure must not issue the item token; after the failed
  // insert is removed, the same due cycle should succeed normally.
  await setEligibleItem(failQueueItemId);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION approval_test_reject_queue_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional queue insert failure'; END; $$
  `);
  await db.execute(sql`
    CREATE TRIGGER approval_test_reject_queue_insert
    BEFORE INSERT ON contractor_email_queue
    FOR EACH ROW EXECUTE FUNCTION approval_test_reject_queue_insert()
  `);
  try {
    const failed = await runReminderJob();
    assert.ok(failed.errors >= 1, "queue insertion error is surfaced in the scheduler result");
    const state = await db.execute(sql`SELECT schedule_token FROM compliance_items WHERE id=${failQueueItemId}`);
    const rows = await db.execute(sql`
      SELECT id FROM contractor_email_queue WHERE entity_type='compliance' AND entity_id=${failQueueItemId}
    `);
    assert.equal(state.rows[0].schedule_token, null, "failed insert preserves the item token state");
    assert.equal(rows.rows.length, 0, "failed insert leaves no queue row");
  } finally {
    await db.execute(sql`DROP TRIGGER IF EXISTS approval_test_reject_queue_insert ON contractor_email_queue`);
    await db.execute(sql`DROP FUNCTION IF EXISTS approval_test_reject_queue_insert()`);
  }
  const queueRetry = await runReminderJob();
  assert.ok(queueRetry.queued >= 1, "queue insertion can be retried successfully");
  const queueRetryState = await db.execute(sql`SELECT schedule_token FROM compliance_items WHERE id=${failQueueItemId}`);
  assert.ok(queueRetryState.rows[0].schedule_token, "successful queue retry issues the schedule token");
  await suppressOtherItems(failQueueItemId);

  // Conversely, an item update failure rolls the inserted queue row back.
  await setEligibleItem(failUpdateItemId);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION approval_test_reject_item_update() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional item update failure'; END; $$
  `);
  await db.execute(sql`
    CREATE TRIGGER approval_test_reject_item_update
    BEFORE UPDATE OF schedule_token ON compliance_items
    FOR EACH ROW EXECUTE FUNCTION approval_test_reject_item_update()
  `);
  try {
    const failed = await runReminderJob();
    assert.ok(failed.errors >= 1, "item update error is surfaced in the scheduler result");
    const state = await db.execute(sql`SELECT schedule_token FROM compliance_items WHERE id=${failUpdateItemId}`);
    const rows = await db.execute(sql`
      SELECT id FROM contractor_email_queue WHERE entity_type='compliance' AND entity_id=${failUpdateItemId}
    `);
    assert.equal(state.rows[0].schedule_token, null, "failed item update preserves the prior token state");
    assert.equal(rows.rows.length, 0, "failed item update rolls back its queue insert");
  } finally {
    await db.execute(sql`DROP TRIGGER IF EXISTS approval_test_reject_item_update ON compliance_items`);
    await db.execute(sql`DROP FUNCTION IF EXISTS approval_test_reject_item_update()`);
  }
  const updateRetry = await runReminderJob();
  assert.ok(updateRetry.queued >= 1, "item update failure can be retried successfully");
  await suppressOtherItems(failUpdateItemId);

  queueRows = await db.execute(sql`
    SELECT id, department_id FROM contractor_email_queue
    WHERE entity_type='compliance' AND entity_id=${currentItemId} AND status='pending'
  `);
  const queueId = Number(queueRows.rows[0].id);
  const queuePath = `/fix-track/contractor-email-queue/${queueId}`;
  const approvePath = `${queuePath}/approve-and-send`;
  const editSendPath = `${queuePath}/edit-and-send`;
  const editBody = {
    subject: "Edited compliance reminder preview",
    bodyText: `Please confirm the exact edited <scope & access> details.\nArrange the visit: /schedule/${originalToken}`,
  };

  assert.equal((await staff.request("POST", approvePath)).status, 403,
    "staff cannot approve and send a queued reminder");
  assert.equal((await staff.request("POST", editSendPath, editBody)).status, 403,
    "staff cannot edit and send a queued reminder");
  assert.equal((await staff.request("PUT", queuePath, {
    subject: editBody.subject,
    bodyHtml: "<p>Unauthorized draft edit</p>",
    bodyText: "Unauthorized draft edit",
  })).status, 403, "staff cannot edit a queued reminder");

  const otherDepartmentQueue = await managerB.request("GET", "/fix-track/contractor-email-queue");
  assert.equal(otherDepartmentQueue.status, 200);
  assert.ok(!otherDepartmentQueue.data.some((entry) => entry.id === queueId),
    "a manager in another department cannot see this pending reminder");
  assert.equal((await managerB.request("PUT", queuePath, {
    subject: editBody.subject, bodyHtml: "<p>Cross-department edit</p>",
  })).status, 404, "cross-department manager cannot edit this reminder");
  assert.equal((await managerB.request("POST", approvePath)).status, 409,
    "cross-department manager cannot approve/send this reminder");
  assert.equal((await foreignManager.request("PUT", queuePath, {
    subject: editBody.subject, bodyHtml: "<p>Cross-client edit</p>",
  })).status, 404, "cross-client manager cannot edit this reminder");
  assert.equal((await foreignManager.request("POST", approvePath)).status, 409,
    "cross-client manager cannot approve/send this reminder");

  const ownDepartmentQueue = await managerA.request("GET", "/fix-track/contractor-email-queue");
  const ownDraft = ownDepartmentQueue.data.find((entry) => entry.id === queueId);
  assert.ok(ownDraft,
    "the manager assigned to the item's department can see the pending reminder");
  assert.ok(ownDraft.emailPreviewJson.text.includes(`/schedule/${originalToken}`),
    "the authorised manager preview restores the original schedule link");

  await clearOutbox();
  const sent = await managerA.request("POST", editSendPath, editBody);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data?.subject, editBody.subject, "the send response uses the edited subject");
  assert.equal(sent.data?.bodyText, editBody.bodyText, "the send response uses the exact edited preview text");

  const outbox = await readOutbox();
  assert.equal(outbox.length, 1, "manager edit-and-send dispatches one provider email");
  assert.equal(outbox[0].subject, editBody.subject);
  assert.equal(outbox[0].text, editBody.bodyText, "provider dispatch matches the edited preview exactly");
  assert.equal(outbox[0].html, sent.data.bodyHtml);
  assert.ok(outbox[0].html.includes("&lt;scope &amp; access&gt;"),
    "edited text is escaped rather than interpreted as email HTML");
  assert.ok(outbox[0].html.includes(`/schedule/${originalToken}`),
    "the edited reminder retains its original working schedule link");

  const sentQueue = await db.execute(sql`
    SELECT status, department_id, approved_by, sent_by, sent_at, email_preview_json
    FROM contractor_email_queue WHERE id=${queueId}
  `);
  assert.equal(sentQueue.rows[0].status, "sent", "successful edit-and-send marks the queue row sent");
  assert.equal(Number(sentQueue.rows[0].department_id), ownerDept);
  assert.equal(sentQueue.rows[0].approved_by, managerA.userId);
  assert.equal(sentQueue.rows[0].sent_by, managerA.userId);
  assert.ok(sentQueue.rows[0].sent_at);
  const storedPreview = sentQueue.rows[0].email_preview_json;
  assert.ok(!JSON.stringify(storedPreview).includes(originalToken),
    "editing never puts the working schedule bearer back into stored preview");
  assert.deepEqual({
    subject: storedPreview.subject,
    html: storedPreview.html.replaceAll("{{BOOKED_TOKEN}}", originalToken),
    text: storedPreview.text.replaceAll("{{BOOKED_TOKEN}}", originalToken),
  }, { subject: outbox[0].subject, html: outbox[0].html, text: outbox[0].text });
  const sentItem = await db.execute(sql`
    SELECT notification_sent_at FROM compliance_items WHERE id=${currentItemId}
  `);
  assert.ok(sentItem.rows[0].notification_sent_at,
    "successful edit-and-send marks the compliance notification sent");
  const afterSend = await runReminderJob();
  assert.equal(afterSend.queued, 0, "a successfully delivered due cycle is not queued again");
  assert.equal((await readOutbox()).length, 1);
});