import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import sharp from 'sharp';
import {
  base as apiBase, certificateInbox as inbox, clearOutbox, createTenant, createUser, decryptTokenPayload, pool, readOutbox,
  runCertificateFollowUpJob,
} from './approval-workflow-fixtures.mjs';

// Certificates sent to ComplyTrack instead of uploaded by a signed-in person:
// emailed to the business's own certificate address (Resend inbound webhook)
// or uploaded by the contractor from the "Upload certificate" link in their
// reminder, visit confirmation and certificate follow-up emails. Each waits in
// "Certificates to confirm" until an Owner checks and saves it. Unknown
// senders are held and never read by AI until accepted.
//
// Storage, Resend and the AI reader are fakes here (InboxDeps); the files are
// generated test pictures, never real certificates. Run:
//   pnpm --filter @workspace/api-server run test:certificate-inbox

const DOMAIN = process.env.CERTIFICATE_INBOX_DOMAIN;
const SECRET = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
assert.equal(DOMAIN, 'certs.test.local', 'run with FRESH_SCHEMA_CERTIFICATE_INBOX=1');
// The fake reader is only called when AI reading is switched on; this is not a key.
process.env.ANTHROPIC_API_KEY = 'test-only-not-an-api-key';

const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
};

// Days are counted from the latest Wednesday, as in certificate-follow-up.
const wednesday = new Date();
wednesday.setUTCDate(wednesday.getUTCDate() - ((wednesday.getUTCDay() + 4) % 7));
const day = (offset) => {
  const date = new Date(wednesday);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

const picture = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 240, g: 240, b: 230 } } })
  .png().toBuffer();

// ----- Fakes -----
const stored = new Map();
const reads = [];
const emails = new Map();
const deps = {
  async fetchEmail(id) {
    const email = emails.get(id);
    if (!email) throw new Error('Provider unavailable');
    return email;
  },
  async storeFile(clientId, bytes, contentType) {
    const path = `/objects/finalized/tenant-${clientId}/${stored.size + 1}.${contentType.split('/')[1]}`;
    stored.set(path, bytes);
    return path;
  },
  async readFile(_clientId, path) { return stored.get(path); },
  async read(input) {
    reads.push(input);
    return {
      certificateType: 'Electrical Installation Condition Report', name: 'EICR certificate',
      itemId: input.itemId ?? input.checks.find((check) => check.title === 'EICR')?.id ?? null, checkReason: 'Matches the EICR check', newCheck: null,
      contractorName: 'Sparky Ltd', issueDate: day(-14), nextInspectionDate: null, nextInspectionSource: 'repeat',
      outcome: 'satisfactory', summary: 'No defects.', defects: [], unclear: [],
      model: 'fake', inputTokens: 0, outputTokens: 0, usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
};
const attachment = (id, { filename = 'certificate.png', size = 40_000, inline = false, bytes = picture } = {}) => ({
  id, filename, contentType: 'image/png', size, inline, download: async () => bytes,
});

let webhookCount = 0;
async function webhook(event, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  const id = `msg_test_${++webhookCount}`;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  const response = await fetch(`${apiBase}/inbound/certificate-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` },
    body,
  });
  return response.status;
}

// The server records the email and tries to fetch it at once; with no Resend
// key that attempt fails and the email stays pending, so the test processes
// it with the fakes (as the recovery job would).
async function received(providerEmailId, details, to) {
  emails.set(providerEmailId, details);
  assert.equal(await webhook({ type: 'email.received', data: {
    email_id: providerEmailId, from: details.from, to: [to], subject: details.subject,
  } }), 200);
  let row;
  for (let i = 0; i < 50; i++) {
    [row] = (await pool.query('SELECT id, status, attempts, last_error FROM certificate_inbox_emails WHERE provider_email_id = $1', [providerEmailId])).rows;
    if (!row || row.status !== 'pending' || row.last_error) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (row?.status === 'pending') await inbox.processInboundEmail(row.id, deps);
  return row ? (await pool.query('SELECT * FROM certificate_inbox_emails WHERE id = $1', [row.id])).rows[0] : null;
}
const itemsFor = async (emailRowId) => (await pool.query(
  'SELECT * FROM certificate_inbox_items WHERE email_id = $1 ORDER BY id', [emailRowId])).rows;
const publicLink = async (token, init) => {
  const response = await fetch(`${apiBase}/certificate-upload/${token}`, init);
  return { status: response.status, data: await response.json().catch(() => null) };
};

try {
  const owner = await createTenant('certificate-inbox');
  const site = ok(await owner.request('POST', '/sites', { name: 'Inbox site', seedStarterChecks: false }), 201);
  const sparky = ok(await owner.request('POST', '/contractors', {
    name: 'Dave Sparks', company: 'Sparky Ltd', email: 'dave@sparky-electrical.test',
  }), 201);
  const eicr = ok(await owner.request('POST', '/compliance-items', {
    title: 'EICR', priority: 'high', siteId: site.id, contractorId: sparky.id, frequencyMonths: 60, dueDate: `${day(-5)}T00:00:00.000Z`,
  }), 201);

  // ── The business's address ────────────────────────────────────────────────
  assert.equal(inbox.addressNameFor('Kilmarnock Golf & Country Club!'), 'kilmarnock-golf-and-country-cl');
  assert.equal(inbox.addressNameFor('***'), 'certificates');
  const shown = ok(await owner.request('GET', '/certificate-inbox'));
  assert.match(shown.address, /^[a-z0-9-]+-[a-z2-9]{5}@certs\.test\.local$/);
  assert.deepEqual(shown.items, []);
  assert.equal(ok(await owner.request('GET', '/certificate-inbox')).address, shown.address, 'the address is made once');
  const address = shown.address;

  // ── Upload link and address in the contractor's emails ────────────────────
  // Reminder (waits for approval): the link is a placeholder in the stored draft.
  ok(await owner.request('POST', `/notifications/send-reminder/${eicr.id}`));
  const [reminder] = (await pool.query(
    `SELECT id, body_html, body_text, encrypted_token_payload FROM contractor_email_queue
     WHERE entity_type = 'compliance' AND entity_id = $1 AND status = 'pending' ORDER BY id`, [eicr.id])).rows;
  const reminderPayload = decryptTokenPayload(reminder.encrypted_token_payload);
  assert.match(reminderPayload.certUpload, /^[a-f0-9]{64}$/);
  assert.ok(reminder.body_text.includes(`/certificate-upload/${inbox.CERTIFICATE_UPLOAD_PLACEHOLDER}`), 'the stored draft holds the placeholder');
  assert.ok(!`${reminder.body_html}${reminder.body_text}`.includes(reminderPayload.certUpload), 'the raw upload token is never stored in the draft');
  assert.ok(reminder.body_text.includes(address), 'the reminder names the certificate address');
  assert.match(reminder.body_html, /Upload certificate/);
  const reminderLink = await inbox.findCertificateUploadLink(reminderPayload.certUpload);
  assert.equal(reminderLink?.itemId, eicr.id);
  const hashes = (await pool.query('SELECT token_hash FROM certificate_upload_links WHERE item_id = $1', [eicr.id])).rows;
  assert.ok(hashes.every((row) => row.token_hash !== reminderPayload.certUpload), 'only the token digest is kept');

  // Approved and sent: the real link goes out; Reply-To stays the business.
  await clearOutbox();
  ok(await owner.request('POST', `/fix-track/contractor-email-queue/${reminder.id}/approve-and-send`));
  const [sentReminder] = await readOutbox();
  assert.ok(sentReminder.text.includes(`/certificate-upload/${reminderPayload.certUpload}`), 'the sent reminder carries the real link');
  assert.ok(!sentReminder.replyTo, 'replies to a reminder go to the business, not the certificate address');

  // The contractor books a visit: the confirmation has its own upload link.
  const bookResponse = await fetch(`${apiBase}/notifications/public/schedule/${reminderPayload.booked}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: `${day(30)}T09:00:00.000Z` }),
  });
  assert.equal(bookResponse.status, 200, await bookResponse.text());
  const [confirmation] = (await pool.query(
    `SELECT id, body_text, encrypted_token_payload FROM contractor_email_queue
     WHERE entity_type = 'compliance' AND entity_id = $1 AND idempotency_key LIKE 'schedule-confirmation-%'`, [eicr.id])).rows;
  const confirmationToken = decryptTokenPayload(confirmation.encrypted_token_payload).certUpload;
  assert.ok(confirmation.body_text.includes(inbox.CERTIFICATE_UPLOAD_PLACEHOLDER));
  assert.ok(confirmation.body_text.includes(address));
  assert.equal((await inbox.findCertificateUploadLink(confirmationToken))?.itemId, eicr.id);
  await clearOutbox();
  ok(await owner.request('POST', `/fix-track/contractor-email-queue/${confirmation.id}/approve-and-send`));
  const [sentConfirmation] = await readOutbox();
  assert.ok(sentConfirmation.text.includes(`/certificate-upload/${confirmationToken}`), 'the sent confirmation carries the real link');

  // The visit happened two weeks ago with no certificate: the follow-up is
  // sent with the link, the address and Reply-To the certificate address.
  ok(await owner.request('PATCH', `/compliance-items/${eicr.id}/status`, { status: 'completed', completedAt: day(-14) }));
  const followUps = [];
  await runCertificateFollowUpJob({ now: new Date(`${day(0)}T08:30:00Z`), send: async (email) => { followUps.push(email); } });
  const followUp = followUps.find((email) => email.subject.includes('EICR'));
  assert.ok(followUp, 'the certificate follow-up was sent');
  assert.equal(followUp.replyTo, address, 'a reply to the certificate chase goes to the certificate address');
  assert.match(followUp.text, /reply to this email with it attached/);
  const followUpToken = followUp.text.match(/certificate-upload\/([a-f0-9]{64})/)?.[1];
  assert.ok(followUpToken, 'the follow-up carries a working upload link');
  const [followUpDraft] = (await pool.query(
    `SELECT body_text, encrypted_token_payload FROM contractor_email_queue
     WHERE entity_type = 'compliance' AND entity_id = $1 AND email_type = 'certificate_followup'`, [eicr.id])).rows;
  assert.ok(!followUpDraft.body_text.includes(followUpToken), 'the stored follow-up holds no raw token');
  assert.equal(decryptTokenPayload(followUpDraft.encrypted_token_payload).certUpload, followUpToken);

  // ── The upload page (no sign-in; the token is the key) ────────────────────
  const page = await publicLink(followUpToken);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.equal(page.data.itemTitle, 'EICR');
  assert.equal(page.data.siteName, 'Inbox site');
  assert.equal(page.data.contractorName, 'Dave Sparks');
  assert.equal(page.data.uploadsLeft, inbox.MAX_UPLOADS_PER_LINK);
  assert.equal((await publicLink('a'.repeat(64))).status, 404, 'an unknown token is refused');
  const junk = await publicLink(followUpToken, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: 'certificate.pdf', mimeType: 'application/pdf', data: Buffer.from('not a certificate').toString('base64') }),
  });
  assert.equal(junk.status, 400, 'a file that is not a PDF, photo or Word document is refused');
  const link = await inbox.findCertificateUploadLink(followUpToken);
  assert.equal(link.uploadsLeft, inbox.MAX_UPLOADS_PER_LINK, 'a refused file does not use up the link');

  const uploaded = await inbox.receiveUploadedCertificate(link, { fileName: 'eicr.png', mimeType: 'image/png', bytes: picture }, deps);
  await uploaded.read;
  const [upload] = (await pool.query('SELECT * FROM certificate_inbox_items WHERE id = $1', [uploaded.inboxItemId])).rows;
  assert.equal(upload.source, 'upload');
  assert.equal(upload.status, 'ready', 'an uploaded certificate is read and waits to be checked');
  assert.equal(upload.item_id, eicr.id);
  assert.equal(upload.contractor_id, sparky.id);
  assert.equal(upload.reading.certificateType, 'Electrical Installation Condition Report');
  assert.equal(upload.reading.usage, undefined, 'usage figures are not kept with the reading');
  assert.equal(reads.at(-1).itemId, eicr.id, 'the reader is told which check the link was for');
  assert.equal((await inbox.findCertificateUploadLink(followUpToken)).uploadsLeft, inbox.MAX_UPLOADS_PER_LINK - 1);
  await pool.query('UPDATE certificate_upload_links SET uploads = $2 WHERE id = $1', [link.id, inbox.MAX_UPLOADS_PER_LINK]);
  assert.equal(await inbox.receiveUploadedCertificate(link, { fileName: 'eicr.png', mimeType: 'image/png', bytes: picture }, deps), null,
    'a used-up link takes no more files');
  await pool.query('UPDATE certificate_upload_links SET expires_at = now() - interval \'1 day\' WHERE id = $1', [link.id]);
  assert.equal((await publicLink(followUpToken)).status, 404, 'an expired link is refused');

  // ── Emailed certificates ──────────────────────────────────────────────────
  assert.equal(await webhook({ type: 'email.received', data: { email_id: 'bad-sig', to: [address] } }, {
    secret: `whsec_${Buffer.from('some-other-secret').toString('base64')}`,
  }), 401, 'a webhook with the wrong signature is refused');
  assert.equal(await webhook({ type: 'email.received', data: { email_id: 'stale', to: [address] } }, {
    timestamp: Math.floor(Date.now() / 1000) - 3600,
  }), 401, 'an old (replayed) webhook is refused');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM certificate_inbox_emails WHERE provider_email_id IN ('bad-sig', 'stale')`)).rows[0].n, 0);

  // From the contractor's own address: kept and read; the small inline logo is not.
  const readsBefore = reads.length;
  const fromContractor = await received('email-contractor', {
    from: 'Dave Sparks <Dave@Sparky-Electrical.test>', subject: 'EICR certificate', text: 'Certificate attached.', headers: null,
    attachments: [attachment('att-1'), attachment('logo', { filename: 'logo.png', size: 4_000, inline: true })],
  }, `Certificates <${address.replace('@', '+eicr@')}>`);
  assert.equal(fromContractor.status, 'done');
  let [emailed, ...extra] = await itemsFor(fromContractor.id);
  assert.equal(extra.length, 0, 'the inline logo is not kept as a certificate');
  assert.equal(emailed.status, 'ready');
  assert.equal(emailed.contractor_id, sparky.id, 'the sender is matched to the contractor');
  assert.equal(emailed.sender_email, 'dave@sparky-electrical.test');
  assert.equal(emailed.item_id, eicr.id, 'the reading matched the check');
  assert.equal(reads.length, readsBefore + 1);
  // Delivered twice (a webhook retry): still one email, one certificate.
  assert.equal(await webhook({ type: 'email.received', data: { email_id: 'email-contractor', from: 'dave@sparky-electrical.test', to: [address] } }), 200);
  await pool.query(`UPDATE certificate_inbox_emails SET status = 'pending' WHERE id = $1`, [fromContractor.id]);
  await inbox.processInboundEmail(fromContractor.id, deps);
  assert.equal((await itemsFor(fromContractor.id)).length, 1, 'processing an email again adds nothing');

  // Someone else at the contractor's company domain is trusted too.
  const fromOffice = await received('email-office', {
    from: 'office@sparky-electrical.test', subject: 'Report', text: null, headers: null, attachments: [attachment('att-2')],
  }, address);
  assert.equal((await itemsFor(fromOffice.id))[0].status, 'ready');

  // A stranger: held, not read by AI.
  const readsBeforeHeld = reads.length;
  const fromStranger = await received('email-stranger', {
    from: 'someone@elsewhere.test', subject: 'Invoice', text: 'See attached', headers: null, attachments: [attachment('att-3')],
  }, address);
  const [held] = await itemsFor(fromStranger.id);
  assert.equal(held.status, 'held');
  assert.equal(held.reading, null);
  assert.match(held.reading_error, /not one of your contractors or users/);
  // A forged From (DMARC fail) is held even with the contractor's address.
  const forged = await received('email-forged', {
    from: 'dave@sparky-electrical.test', subject: 'EICR', text: null,
    headers: { 'Authentication-Results': 'mx.resend.test; spf=fail; dmarc=fail header.from=sparky-electrical.test' },
    attachments: [attachment('att-4')],
  }, address);
  assert.equal((await itemsFor(forged.id))[0].status, 'held');
  assert.equal(reads.length, readsBeforeHeld, 'held certificates are never read until accepted');

  // A contractor's reply with no certificate is kept as a message.
  const reply = await received('email-reply', {
    from: 'dave@sparky-electrical.test', subject: 'Re: Certificate needed: EICR', text: 'I will send it on Friday.', headers: null, attachments: [],
  }, address);
  const [message] = await itemsFor(reply.id);
  assert.equal(message.status, 'message');
  assert.equal(message.message_text, 'I will send it on Friday.');
  // A stranger's email with nothing attached is dropped.
  const spam = await received('email-spam', {
    from: 'offers@spam.test', subject: 'Offer', text: 'Buy now', headers: null, attachments: [],
  }, address);
  assert.equal(spam.status, 'ignored');
  assert.equal((await itemsFor(spam.id)).length, 0);
  // An address that is not a business's is ignored.
  const nobody = await received('email-nobody', {
    from: 'dave@sparky-electrical.test', subject: 'EICR', text: null, headers: null, attachments: [attachment('att-5')],
  }, `nobody-abcde@${DOMAIN}`);
  assert.equal(nobody.status, 'ignored');
  assert.equal(nobody.client_id, null);

  // The provider unavailable: retried, then given up after five attempts.
  assert.equal(await webhook({ type: 'email.received', data: { email_id: 'email-unavailable', from: 'dave@sparky-electrical.test', to: [address] } }), 200);
  const [unavailable] = (await pool.query(`SELECT id FROM certificate_inbox_emails WHERE provider_email_id = 'email-unavailable'`)).rows;
  await pool.query(`UPDATE certificate_inbox_emails SET attempts = 4, status = 'pending' WHERE id = $1`, [unavailable.id]);
  await inbox.processInboundEmail(unavailable.id, deps);
  const [gaveUp] = (await pool.query('SELECT status, last_error FROM certificate_inbox_emails WHERE id = $1', [unavailable.id])).rows;
  assert.equal(gaveUp.status, 'failed');
  assert.match(gaveUp.last_error, /Provider unavailable/);

  // ── Who can see and act on the list ───────────────────────────────────────
  const staff = await createUser(owner, { role: 'client_staff' });
  const viewer = await createUser(owner, { role: 'client_viewer' });
  assert.equal((await staff.request('GET', '/certificate-inbox')).status, 403);
  assert.equal((await viewer.request('GET', '/certificate-inbox')).status, 403);
  assert.equal((await viewer.request('POST', `/certificate-inbox/${message.id}/dismiss`)).status, 403);
  const other = await createTenant('certificate-inbox-other');
  const otherItem = ok(await other.request('POST', '/compliance-items', {
    title: 'Other business check', priority: 'high', frequencyMonths: 12, dueDate: `${day(10)}T00:00:00.000Z`,
  }), 201);
  assert.ok(!ok(await other.request('GET', '/certificate-inbox')).items.length, "another business sees none of these");
  assert.equal((await other.request('POST', `/certificate-inbox/${emailed.id}/dismiss`)).status, 404);
  assert.equal((await other.request('POST', `/certificate-inbox/${emailed.id}/file`, {
    itemId: otherItem.id, certificate: { name: 'Stolen' },
  })).status, 409);

  const list = ok(await owner.request('GET', '/certificate-inbox'));
  const byId = new Map(list.items.map((item) => [item.id, item]));
  assert.equal(byId.get(emailed.id).status, 'ready');
  assert.equal(byId.get(emailed.id).contractorName, 'Dave Sparks');
  assert.equal(byId.get(emailed.id).itemTitle, 'EICR');
  assert.equal(byId.get(held.id).status, 'held');
  assert.equal(byId.get(message.id).messageText, 'I will send it on Friday.');

  // ── Checking and saving ───────────────────────────────────────────────────
  // Into another business's check: refused, and the certificate still waits.
  assert.equal((await owner.request('POST', `/certificate-inbox/${emailed.id}/file`, {
    itemId: otherItem.id, certificate: { name: 'EICR certificate' },
  })).status, 404);
  assert.equal((await pool.query('SELECT handled_at FROM certificate_inbox_items WHERE id = $1', [emailed.id])).rows[0].handled_at, null);
  const certificate = ok(await owner.request('POST', `/certificate-inbox/${emailed.id}/file`, {
    itemId: eicr.id,
    certificate: { name: 'EICR certificate', outcome: 'satisfactory', issueDate: `${day(-14)}T00:00:00.000Z`, readByAi: true },
  }), 201);
  assert.equal(certificate.fileUrl, emailed.object_path, 'the emailed file is the certificate file');
  const [filed] = (await pool.query('SELECT status, certificate_id FROM certificate_inbox_items WHERE id = $1', [emailed.id])).rows;
  assert.equal(filed.status, 'filed');
  assert.equal(filed.certificate_id, certificate.id);
  assert.equal((await owner.request('POST', `/certificate-inbox/${emailed.id}/file`, {
    itemId: eicr.id, certificate: { name: 'Again' },
  })).status, 409, 'a certificate is saved once');
  const [audit] = (await pool.query(
    `SELECT metadata FROM audit_events WHERE entity_id = $1 AND action = 'certificate_added' ORDER BY id DESC LIMIT 1`, [eicr.id])).rows;
  assert.equal(audit.metadata.certificateInboxItemId, emailed.id);
  assert.ok(!ok(await owner.request('GET', '/certificate-inbox')).items.some((item) => item.id === emailed.id));

  // Accepting a held one: read (here without AI on the server) and ready to check.
  const accepted = ok(await owner.request('POST', `/certificate-inbox/${held.id}/read`));
  assert.equal(accepted.status, 'ready');
  assert.equal((await owner.request('POST', `/certificate-inbox/${message.id}/read`)).status, 404, 'a message has nothing to read');

  // Dismissing: gone from the list, with its file.
  ok(await owner.request('POST', `/certificate-inbox/${message.id}/dismiss`));
  ok(await owner.request('POST', `/certificate-inbox/${held.id}/dismiss`));
  const [dismissed] = (await pool.query('SELECT status, object_path, handled_by FROM certificate_inbox_items WHERE id = $1', [held.id])).rows;
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(dismissed.object_path, null);
  assert.equal(dismissed.handled_by, owner.userId);
  assert.equal((await owner.request('POST', `/certificate-inbox/${held.id}/dismiss`)).status, 404);

  // ── A new address ─────────────────────────────────────────────────────────
  const changed = ok(await owner.request('POST', '/certificate-inbox/address'));
  assert.notEqual(changed.address, address);
  const toOld = await received('email-old-address', {
    from: 'dave@sparky-electrical.test', subject: 'EICR', text: null, headers: null, attachments: [attachment('att-6')],
  }, address);
  assert.equal(toOld.status, 'ignored', 'the old address stops working');
  const toNew = await received('email-new-address', {
    from: 'dave@sparky-electrical.test', subject: 'EICR', text: null, headers: null, attachments: [attachment('att-7')],
  }, changed.address);
  assert.equal(toNew.status, 'done');

  // ── Pure helpers ──────────────────────────────────────────────────────────
  assert.deepEqual(inbox.parseAddress('"Dave Sparks" <Dave@Sparky.test>'), { email: 'dave@sparky.test', name: 'Dave Sparks' });
  assert.deepEqual(inbox.inboxLocalParts(['a-b+x@certs.test.local', 'c@other.test', 'A-B@certs.test.local'], 'certs.test.local'), ['a-b']);
  assert.equal(inbox.senderLooksForged({ 'authentication-results': 'dmarc=pass' }), false);

  console.log('Certificate inbox: addresses, upload links, emailed certificates, checking and saving all pass.');
} finally {
  await pool.end();
}
