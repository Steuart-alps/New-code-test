import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Contractors on the phone (components/contractors-logic.ts): the website's
// list status (lib/contractor-list-status.ts), certificate badges
// (components/badges.tsx ExpiryBadge), tap-to-call/email links, and the
// contractor email approval wording and endpoints
// (lib/contractor-approval-actions.ts).
const source = await readFile(new URL('../components/contractors-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  daysUntilExpiry, contractorListStatus, filterContractors, countMissingOrExpired, certificateExpiry,
  formatDay, telUrl, mailtoUrl, emailTypeLabel, approvalConfirmation, approvalRequest,
  approvalSuccessMessage, approvalButtonLabel, groupApprovalsBySite, canApproveContractorEmails,
  CANCELLATION_APPROVAL_CONFIRMATION, CANCELLATION_DISMISS_CONFIRMATION, EMAIL_DISMISS_CONFIRMATION,
  CONTRACTOR_STATUS_LABEL, normalizeContractors, normalizeContractor, normalizeCertificates, normalizeQueueItems,
  normalizeChecks, checkStatusLabel,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const now = new Date(2026, 9, 15, 23, 30); // 15 Oct 2026, late evening on the device

// Calendar days, not milliseconds: valid through the expiry day itself.
assert.equal(daysUntilExpiry('2026-10-15T00:00:00.000Z', now), 0);
assert.equal(daysUntilExpiry('2026-10-14', now), -1);
assert.equal(daysUntilExpiry('2026-11-14', now), 30);
assert.equal(daysUntilExpiry('2026-02-30', now), null);
assert.equal(daysUntilExpiry(null, now), null);
assert.equal(daysUntilExpiry('soon', now), null);

// List status: the website's three levels and problem wording.
const base = { id: 1, name: 'Ace Gas', email: 'ace@example.test', gasSafeRegistration: 'Registered' };
assert.deepEqual(contractorListStatus({ ...base, publicLiabilityExpiry: '2027-03-01T00:00:00.000Z', dbsExpiryDate: '2028-01-01' }, now),
  { level: 'complete', problems: [] });
assert.deepEqual(contractorListStatus({ ...base, publicLiabilityExpiry: '2026-10-15', dbsExpiryDate: '2026-10-25' }, now),
  { level: 'expiring', problems: ['Public liability insurance: expiring today', 'DBS / PVG check: expiring in 10 days'] });
assert.deepEqual(contractorListStatus({ ...base, publicLiabilityExpiry: '2026-10-01', dbsExpiryDate: null, gasSafeRegistration: ' ' }, now), {
  level: 'missing-or-expired',
  problems: ['Public liability insurance: expired', 'DBS / PVG check: missing expiry date', 'Gas Safe registration: missing'],
});
assert.equal(CONTRACTOR_STATUS_LABEL['missing-or-expired'], 'Missing or expired');
assert.equal(CONTRACTOR_STATUS_LABEL.complete, 'Up to date');

// Search (name or company) and the "Missing or expired" filter.
const list = [
  { ...base, id: 1, publicLiabilityExpiry: '2027-03-01', dbsExpiryDate: '2028-01-01' },
  { ...base, id: 2, name: 'Bob Smith', company: 'Sparks Ltd', publicLiabilityExpiry: '2026-01-01', dbsExpiryDate: '2028-01-01' },
  { ...base, id: 3, name: 'Cara', company: null, publicLiabilityExpiry: '2027-03-01', dbsExpiryDate: '2028-01-01', gasSafeRegistration: null },
];
assert.deepEqual(filterContractors(list, 'sparks', false, now).map((c) => c.id), [2]);
assert.deepEqual(filterContractors(list, ' ACE ', false, now).map((c) => c.id), [1]);
assert.deepEqual(filterContractors(list, '', true, now).map((c) => c.id), [2, 3]);
assert.equal(countMissingOrExpired(list, now), 2);

// Certificate badges.
assert.deepEqual(certificateExpiry(null, now), { level: 'none', label: 'No Expiry' });
assert.deepEqual(certificateExpiry('2026-10-14', now), { level: 'expired', label: 'Expired' });
assert.deepEqual(certificateExpiry('2026-10-15', now), { level: 'expiring', label: 'Expiring Soon (0d)' });
assert.deepEqual(certificateExpiry('2026-11-14T00:00:00.000Z', now), { level: 'expiring', label: 'Expiring Soon (30d)' });
assert.deepEqual(certificateExpiry('2026-11-15', now), { level: 'valid', label: 'Valid' });

assert.equal(formatDay('2026-03-01T00:00:00.000Z'), '1 Mar 2026');
assert.equal(formatDay(null), null);
assert.equal(formatDay('2026-13-01'), null);

// Tap to call / email.
assert.equal(telUrl('+44 (0)20 7946 0018'), 'tel:+4402079460018');
assert.equal(telUrl('07700 900123 ext'), 'tel:07700900123');
assert.equal(telUrl('n/a'), null);
assert.equal(telUrl(null), null);
assert.equal(mailtoUrl(' ace@example.test '), 'mailto:ace@example.test');
assert.equal(mailtoUrl('a@b.test,c@d.test'), null, 'one address only');
assert.equal(mailtoUrl('ace@example.test?cc=x@y.test'), null, 'no injected headers');
assert.equal(mailtoUrl(''), null);

// Approvals: the website's tags, confirmations and the existing endpoints.
assert.equal(emailTypeLabel({ emailType: 'cancellation' }), 'Calendar Cancellation');
assert.equal(emailTypeLabel({ emailType: 'quote_request' }), 'Requesting Quote');
assert.equal(emailTypeLabel({ emailType: 'reminder' }), 'Reminder');
assert.equal(emailTypeLabel({ emailType: 'assignment' }), 'Assigning Job');
assert.equal(approvalConfirmation({ emailType: 'assignment' }, 'approve'), null, 'ordinary approve sends at once, as on the website');
assert.equal(approvalConfirmation({ emailType: 'cancellation' }, 'approve'), CANCELLATION_APPROVAL_CONFIRMATION);
assert.equal(approvalConfirmation({ emailType: 'cancellation' }, 'dismiss'), CANCELLATION_DISMISS_CONFIRMATION);
assert.equal(approvalConfirmation({ emailType: 'reminder' }, 'dismiss'), EMAIL_DISMISS_CONFIRMATION);
assert.deepEqual(approvalRequest(12, 'approve'), {
  path: '/api/fix-track/contractor-email-queue/12/approve-and-send', init: { method: 'POST', body: '{}' },
});
assert.deepEqual(approvalRequest(12, 'dismiss'), {
  path: '/api/fix-track/contractor-email-queue/12/cancel', init: { method: 'POST' },
});
assert.equal(approvalSuccessMessage({ emailType: 'assignment' }, 'approve'), 'Email approved and sent');
assert.equal(approvalSuccessMessage({ emailType: 'cancellation' }, 'approve'), 'Calendar cancellation approved and sent');
assert.equal(approvalSuccessMessage({ emailType: 'assignment' }, 'dismiss'), 'Email cancelled');
assert.equal(approvalSuccessMessage({ emailType: 'cancellation' }, 'dismiss'), 'Calendar cancellation dismissed');
assert.equal(approvalButtonLabel({ emailType: 'cancellation' }, 'approve'), 'Approve Cancellation');
assert.equal(approvalButtonLabel({ emailType: 'reminder' }, 'dismiss'), 'Cancel');

assert.deepEqual(groupApprovalsBySite([
  { id: 1, siteName: 'Zeta' }, { id: 2, siteName: null }, { id: 3, siteName: 'Alpha' }, { id: 4, siteName: 'Zeta' },
]).map(([site, items]) => [site, items.map((i) => i.id)]), [['Alpha', [3]], ['No Site', [2]], ['Zeta', [1, 4]]]);

// Responses are read in either field style (routes are moving from
// snake_case to camelCase); both shapes give the same records.
const contractorSnake = {
  id: 5, name: 'Ace Gas', company: 'Ace Ltd', email: 'ace@example.test', phone: '0161 000 0000', address: null,
  gas_safe_number: '123456', gas_safe_registration: 'Registered', public_liability_expiry: '2027-01-01T00:00:00.000Z',
  dbs_type: 'Enhanced', dbs_expiry_date: '2028-01-01T00:00:00.000Z',
};
const contractorCamel = {
  id: 5, name: 'Ace Gas', company: 'Ace Ltd', email: 'ace@example.test', phone: '0161 000 0000', address: null,
  gasSafeNumber: '123456', gasSafeRegistration: 'Registered', publicLiabilityExpiry: '2027-01-01T00:00:00.000Z',
  dbsType: 'Enhanced', dbsExpiryDate: '2028-01-01T00:00:00.000Z',
};
assert.deepEqual(normalizeContractors([contractorSnake]), normalizeContractors([contractorCamel]));
assert.equal(normalizeContractors([contractorCamel])[0].publicLiabilityExpiry, '2027-01-01T00:00:00.000Z');
assert.equal(normalizeContractor(contractorSnake).gasSafeRegistration, 'Registered');
assert.equal(normalizeContractor({ error: 'Contractor not found' }), null);
assert.equal(normalizeContractor([contractorCamel]), null);
assert.deepEqual(normalizeContractors({ not: 'a list' }), []);

const certSnake = { id: 9, certificate_name: 'IPAF', issuer: 'IPAF Ltd', completed_date: '2024-01-01', expiry_date: '2029-01-01', notes: null };
const certCamel = { id: 9, certificateName: 'IPAF', issuer: 'IPAF Ltd', completedDate: '2024-01-01', expiryDate: '2029-01-01', notes: null };
const expectedCert = { id: 9, name: 'IPAF', issuer: 'IPAF Ltd', completedDate: '2024-01-01', expiryDate: '2029-01-01', notes: null };
assert.deepEqual(normalizeCertificates([certSnake]), [expectedCert]);
assert.deepEqual(normalizeCertificates([certCamel]), [expectedCert]);

const queueCamel = {
  id: 3, emailType: 'cancellation', createdAt: '2026-10-14T09:00:00.000Z', requestedBy: 'Sam',
  emailPreviewJson: { subject: 'Cancelled', text: 'Dear Ace' }, siteName: 'Hotel', contractorName: 'Ace Gas', jobTitle: 'Boiler',
};
const queueSnake = {
  id: 3, email_type: 'cancellation', created_at: '2026-10-14T09:00:00.000Z', requested_by: 'Sam',
  email_preview_json: { subject: 'Cancelled', text: 'Dear Ace' }, site_name: 'Hotel', contractor_name: 'Ace Gas', item_title: 'Boiler',
};
const expectedQueue = {
  id: 3, emailType: 'cancellation', createdAt: '2026-10-14T09:00:00.000Z', requestedBy: 'Sam',
  subject: 'Cancelled', text: 'Dear Ace', siteName: 'Hotel', contractorName: 'Ace Gas', jobTitle: 'Boiler',
};
assert.deepEqual(normalizeQueueItems([queueCamel]), [expectedQueue]);
assert.deepEqual(normalizeQueueItems([queueSnake]), [expectedQueue]);
assert.deepEqual(normalizeQueueItems([{ ...queueCamel, emailPreviewJson: null }])[0].subject, '', 'a damaged draft still lists');

assert.deepEqual(normalizeChecks([{ id: 1, title: 'Gas safety', status: 'in_progress', dueDate: '2026-11-01T00:00:00.000Z' }]),
  normalizeChecks([{ id: 1, title: 'Gas safety', status: 'in_progress', due_date: '2026-11-01T00:00:00.000Z' }]));
assert.equal(checkStatusLabel('in_progress'), 'In Progress');
assert.equal(checkStatusLabel('completed'), 'Completed');

for (const role of ['client_admin', 'consultant']) assert.equal(canApproveContractorEmails(role), true);
for (const role of ['client_staff', 'client_viewer', undefined]) assert.equal(canApproveContractorEmails(role), false);

console.log('contractors logic: ok');
