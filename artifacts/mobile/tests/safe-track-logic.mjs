import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// SafeTrack on the phone (components/safe-track-logic.ts): "already
// acknowledged" from GET /safe-track/:sub/:id/acknowledgements, whichever
// shape the API returns.
const source = await readFile(new URL('../components/safe-track-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { acknowledgedByCurrentUser, isOwnAcknowledgement } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const me = 7;

// Rows with no account to match on (only the roster entry and name): never
// counted as the user's own.
assert.equal(acknowledgedByCurrentUser([
  { id: 1, staff_roster_id: 3, staff_name: 'Sam', signature: null, acknowledged_at: '2026-10-01T09:00:00Z' },
], me), false);

// snake_case acknowledged_by (the account that recorded it).
assert.equal(acknowledgedByCurrentUser([{ id: 1, staff_name: 'Sam', acknowledged_by: 9 }, { id: 2, staff_name: 'Me', acknowledged_by: me }], me), true);
assert.equal(acknowledgedByCurrentUser([{ id: 1, staff_name: 'Sam', acknowledged_by: 9 }], me), false);
assert.equal(acknowledgedByCurrentUser([{ id: 1, acknowledged_by: null }], me), false);
assert.equal(acknowledgedByCurrentUser([{ id: 1, acknowledged_by: me }], null), false, 'no signed-in user: nothing is own');

// camelCase acknowledgedBy.
assert.equal(acknowledgedByCurrentUser([{ id: 2, staffName: 'Me', acknowledgedBy: me }], me), true);
assert.equal(acknowledgedByCurrentUser([{ id: 2, staffName: 'Sam', acknowledgedBy: 9 }], me), false);

// The own-row flag wins over the recorder: a manager who bulk-signed staff is
// the recorder of rows that are not theirs, and a row recorded by someone
// else can be the user's own (matched by roster entry).
assert.equal(acknowledgedByCurrentUser([
  { id: 1, staff_roster_id: 3, staff_name: 'Sam', acknowledged_by: me, acknowledged_by_me: false },
  { id: 2, staff_roster_id: 4, staff_name: 'Kim', acknowledged_by: me, acknowledged_by_me: false },
], me), false, 'snake_case: bulk sign-off recorded by me is not my acknowledgement');
assert.equal(acknowledgedByCurrentUser([
  { id: 3, staff_roster_id: 5, staff_name: 'Me', acknowledged_by: 2, acknowledged_by_me: true },
], me), true, 'snake_case: my roster entry signed by a manager');
assert.equal(acknowledgedByCurrentUser([
  { id: 1, staffRosterId: 3, staffName: 'Sam', acknowledgedBy: me, acknowledgedByMe: false },
], me), false, 'camelCase: flag wins over recorder');
assert.equal(acknowledgedByCurrentUser([
  { id: 3, staffRosterId: 5, staffName: 'Me', acknowledgedBy: 2, acknowledgedByMe: true },
], me), true, 'camelCase: own flag');

// Bad responses.
assert.equal(acknowledgedByCurrentUser({ error: 'nope' }, me), false);
assert.equal(acknowledgedByCurrentUser(undefined, me), false);
assert.equal(isOwnAcknowledgement(null, me), false);
assert.equal(isOwnAcknowledgement({ acknowledged_by: String(me) }, me), true, 'a numeric string id still matches');

console.log('SafeTrack logic tests passed: own acknowledgement from snake_case and camelCase rows, own-row flag over recorder.');
