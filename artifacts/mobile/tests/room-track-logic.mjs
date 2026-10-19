import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// RoomTrack on the phone (components/room-track-logic.ts): room status for
// today, rooms saved on the device, recent checks per site and the POST
// /room-track/checks body. Shapes mirror artifacts/api-server/src/routes/room-track.ts.
const source = await readFile(new URL('../components/room-track-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  buildRoomCheckBody, checksByRoom, localIsoDate, localIsoDateDaysBefore, recentChecks,
  roomLabel, roomStatus, roomsSavedOnDevice, visibleRooms,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const room = (id, overrides = {}) => ({ id, roomNumber: String(100 + id), name: null, floor: 'First', siteId: 7, active: true, notes: null, ...overrides });
const check = (id, roomId, checkDate, values = {}, overrides = {}) => ({
  id, roomId, siteId: 7, checkDate, clean: false, tidy: false, toStandard: false, notes: null, checkedBy: null, ...values, ...overrides,
});

// Local calendar dates, not UTC.
assert.equal(localIsoDate(new Date(2026, 9, 15, 0, 30)), '2026-10-15');
assert.equal(localIsoDateDaysBefore(6, new Date(2026, 9, 15, 23, 0)), '2026-10-09');
assert.equal(localIsoDateDaysBefore(1, new Date(2026, 2, 1, 12)), '2026-02-28');

// Labels follow the website: room number, else name.
assert.equal(roomLabel(room(1)), '101');
assert.equal(roomLabel(room(2, { roomNumber: '', name: 'Bluebell suite' })), 'Bluebell suite');
assert.equal(roomLabel(undefined, 9), 'Room 9', 'archived rooms in history still get a label');

// Only active rooms of the chosen site; null shows every site (and rooms with none).
const rooms = [room(1), room(2, { siteId: 8 }), room(3, { active: false }), room(4, { siteId: null })];
assert.deepEqual(visibleRooms(rooms, 7).map((r) => r.id), [1]);
assert.deepEqual(visibleRooms(rooms, null).map((r) => r.id), [1, 2, 4]);

// Today's status: complete needs all three outcomes.
const today = '2026-10-15';
const checks = [
  check(10, 1, today, { clean: true, tidy: true, toStandard: true }),
  check(11, 2, today, { clean: true }, { siteId: 8 }),
  check(9, 4, '2026-10-14', { clean: true, tidy: true, toStandard: true }, { siteId: null }),
];
const byRoom = checksByRoom(checks, today);
assert.equal(byRoom.get(1).id, 10);
assert.equal(byRoom.has(4), false, "yesterday's check does not count for today");
assert.deepEqual(roomStatus(byRoom.get(1), false), { kind: 'complete' });
assert.deepEqual(roomStatus(byRoom.get(2), false), { kind: 'attention', count: 1 });
assert.deepEqual(roomStatus(undefined, false), { kind: 'unchecked' });
assert.deepEqual(roomStatus(undefined, true), { kind: 'saved-on-device' });
assert.deepEqual(roomStatus(byRoom.get(1), true), { kind: 'complete' }, 'a stored check wins over a device copy');

// Device copies waiting to send mark their room for that day only.
const saved = roomsSavedOnDevice([
  { body: { roomId: 4, checkDate: today } },
  { body: { roomId: 2, checkDate: '2026-10-14' } },
], today);
assert.deepEqual([...saved], [4]);

// Recent checks: newest first, filtered by site.
assert.deepEqual(recentChecks(checks, null).map((c) => c.id), [11, 10, 9]);
assert.deepEqual(recentChecks(checks, 7).map((c) => c.id), [10]);
assert.equal(recentChecks(checks, null, 2).length, 2);

// The create body: the room's own site, trimmed text, nulls for blanks.
const built = buildRoomCheckBody({
  room: room(1), checkDate: today, values: { clean: true, tidy: false, toStandard: true }, notes: '  Bin full ', checkedBy: ' Sam ',
});
assert.deepEqual(built, { body: { roomId: 1, checkDate: today, siteId: 7, clean: true, tidy: false, toStandard: true, notes: 'Bin full', checkedBy: 'Sam' } });
const blank = buildRoomCheckBody({ room: room(4, { siteId: null }), checkDate: today, values: { clean: false, tidy: false, toStandard: false }, notes: ' ', checkedBy: '' });
assert.deepEqual(blank.body, { roomId: 4, checkDate: today, siteId: null, clean: false, tidy: false, toStandard: false, notes: null, checkedBy: null });
assert.match(buildRoomCheckBody({ room: room(3, { active: false }), checkDate: today, values: blank.body, notes: '', checkedBy: '' }).error, /archived/);
assert.match(buildRoomCheckBody({ room: room(1), checkDate: today, values: blank.body, notes: 'x'.repeat(5001), checkedBy: '' }).error, /Notes/);
assert.match(buildRoomCheckBody({ room: room(1), checkDate: today, values: blank.body, notes: '', checkedBy: 'x'.repeat(201) }).error, /Checked by/);

console.log('RoomTrack logic tests passed: local dates, site filter, today status, device copies, recent checks, create body.');
