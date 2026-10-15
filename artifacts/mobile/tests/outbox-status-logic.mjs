import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// How records saved on the phone are described (components/outbox-status-logic.ts):
// saved on this phone, syncing, synced and conflict / not accepted; the
// app-wide count; and the "needs a connection" message for internet-only
// actions. Also checks which screens send through the device outbox.
const source = await readFile(new URL('../components/outbox-status-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  entryStatus, outboxSummary, rememberWaiting, syncedEntries, isConnectionError, onlineActionMessage, NEEDS_CONNECTION,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

// The four states.
assert.deepEqual(entryStatus({ state: 'queued' }), { tone: 'queued', title: 'Saved on this phone', detail: 'Waiting to send' });
assert.equal(entryStatus({ state: 'queued', error: 'Network request failed' }).detail, 'Waiting to send · Network request failed');
assert.equal(entryStatus({ state: 'sending' }).title, 'Syncing…');
assert.deepEqual(entryStatus({ state: 'sent' }), { tone: 'synced', title: 'Synced', detail: null });
const conflict = entryStatus({ state: 'failed', rejection: 'conflict', error: 'This task is already marked done' });
assert.equal(conflict.tone, 'conflict');
assert.match(conflict.title, /^Conflict/);
assert.equal(conflict.detail, 'This task is already marked done', 'the server reason is shown');
assert.equal(entryStatus({ state: 'failed', rejection: 'rejected', error: 'Invalid data' }).tone, 'rejected');
assert.equal(entryStatus({ state: 'failed' }).tone, 'rejected', 'entries saved before rejection kinds existed');

// App-wide count: waiting and rejected entries across both outboxes; synced
// entries are not counted.
const entries = [{ state: 'queued' }, { state: 'sending' }, { state: 'failed' }, { state: 'sent' }];
assert.deepEqual(outboxSummary(entries), {
  waiting: 2, attention: 1, badge: '3', headline: '2 saved on this phone, waiting to send · 1 needs attention',
});
assert.equal(outboxSummary(entries, 1, 1).badge, '5', 'KitchenTrack diary saves are included');
assert.deepEqual(outboxSummary([{ state: 'sent' }]), { waiting: 0, attention: 0, badge: undefined, headline: null });
assert.equal(outboxSummary(Array.from({ length: 120 }, () => ({ state: 'queued' }))).badge, '99+');
assert.equal(outboxSummary([{ state: 'failed' }, { state: 'failed' }]).headline, '2 need attention');

// Synced rows: only entries the screen saw waiting (a failed attempt, a
// rejection, or present when it opened); a save sent at once adds no row.
{
  const seen = new Set();
  rememberWaiting(seen, [{ entryId: 'old', state: 'queued' }], true);
  rememberWaiting(seen, [
    { entryId: 'offline', state: 'queued', error: 'Network request failed' },
    { entryId: 'online', state: 'queued' },
    { entryId: 'sending', state: 'sending' },
    { entryId: 'rejected', state: 'failed' },
  ], false);
  assert.deepEqual([...seen].sort(), ['offline', 'old', 'rejected']);
  const all = [
    { entryId: 'old', state: 'sent' }, { entryId: 'online', state: 'sent' },
    { entryId: 'offline', state: 'sent' }, { entryId: 'rejected', state: 'failed' },
  ];
  assert.deepEqual(syncedEntries(seen, all).map((entry) => entry.entryId), ['offline', 'old'], 'newest first');
}

// Internet-only actions: a failed request says it needs a connection; an
// answer from the server keeps its own message.
assert.equal(isConnectionError(new TypeError('Network request failed')), true);
assert.equal(isConnectionError(Object.assign(new Error('Aborted'), { name: 'AbortError' })), true);
assert.equal(isConnectionError(new Error('Failed to fetch')), true);
assert.equal(isConnectionError(Object.assign(new Error('Request failed (503)'), { status: 503 })), false, 'a server answer');
assert.equal(isConnectionError(Object.assign(new Error('network policy'), { status: 400 })), false);
assert.equal(isConnectionError(new Error('Enter your name before saving.')), false);
assert.equal(isConnectionError(null), false);
assert.equal(onlineActionMessage(new TypeError('Network request failed')), NEEDS_CONNECTION);
assert.equal(onlineActionMessage(new TypeError('Network request failed'), 'x', 'Signing in needs a connection.'), 'Signing in needs a connection.');
assert.equal(onlineActionMessage(Object.assign(new Error('Invalid code'), { status: 401 })), 'Invalid code');
assert.equal(onlineActionMessage({}, 'Fallback'), 'Fallback');

// Screens: offline-capable writes go through the shared outbox; internet-only
// ones explain that they need a connection.
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const newIssue = await read('../app/issues/new.tsx');
assert.ok(newIssue.includes("useRecordOutbox('fix-issue')"), 'issue reports without photos are saved on the phone');
assert.ok(newIssue.includes('Photos need a connection') && newIssue.includes('Save without photos'),
  'a report with photos offline offers to save without them instead of failing silently');
const issue = await read('../app/issues/[id].tsx');
assert.ok(issue.includes("useOutboxAction('fix-note')") && issue.includes('<OutboxEntries'), 'issue notes are saved on the phone');
assert.ok(issue.includes("onlineActionMessage(err)"), 'status changes say they need a connection');
assert.ok((await read('../app/(tabs)/issues.tsx')).includes("useRecordOutbox('fix-issue')"), 'the Issues tab lists unsent reports');
const safe = await read('../app/checks/safe-track.tsx');
assert.ok(safe.includes("useOutboxAction('safe-ack')") && safe.includes('<OutboxEntries'), 'SafeTrack acknowledgements are saved on the phone');
const docs = await read('../app/(tabs)/docs.tsx');
assert.ok(docs.includes("useOutboxAction('doc-ack')") && docs.includes('<OutboxEntries'), 'DocTrack acknowledgements are saved on the phone');
assert.ok(docs.includes("onlineActionMessage(error)"), 'opening a document says it needs a connection');
assert.ok((await read('../app/(tabs)/index.tsx')).includes('<OutboxStatus />'), 'Today shows the app-wide indicator');
const tabs = await read('../app/(tabs)/_layout.tsx');
assert.ok(tabs.includes('tabBarBadge: badge') && tabs.includes('NativeTabs.Trigger.Badge'), 'the Today tab carries the unsent count');
assert.ok((await read('../app/(auth)/login.tsx')).includes('Signing in needs an internet connection'));
assert.ok((await read('../app/account/delete.tsx')).includes('A deletion request needs an internet connection'));
assert.ok((await read('../hooks/useStagedPhotoEvidence.ts')).includes('Photos need an internet connection'));
const panel = await read('../components/OutboxEntries.tsx');
assert.ok(panel.includes('entryStatus(entry)') && panel.includes("'Discard'"), 'one panel shows every state, with discard');

console.log('outbox status logic: ok');
