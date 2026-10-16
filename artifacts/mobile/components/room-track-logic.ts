/**
 * RoomTrack on the phone: room list status, recent checks and the room check
 * body, mirroring the website (compliance-tracker pages/room-track.tsx).
 * Rooms are administered on the website only.
 *
 * Import-free so tests can load it directly with Node.
 */
export interface RoomTrackRoom {
  id: number;
  roomNumber: string;
  name?: string | null;
  floor?: string | null;
  siteId?: number | null;
  active: boolean;
  notes?: string | null;
}

export interface RoomTrackCheck {
  id: number;
  roomId: number;
  siteId?: number | null;
  checkDate: string;
  clean: boolean;
  tidy: boolean;
  toStandard: boolean;
  notes?: string | null;
  checkedBy?: string | null;
}

export interface RoomCheckValues { clean: boolean; tidy: boolean; toStandard: boolean }

export const ROOM_OUTCOMES: { key: keyof RoomCheckValues; label: string }[] = [
  { key: 'clean', label: 'Clean' },
  { key: 'tidy', label: 'Tidy' },
  { key: 'toStandard', label: 'To standard' },
];

/** Same limits as the API (routes/room-track.ts). */
export const ROOM_NOTES_MAX = 5000;
export const ROOM_CHECKED_BY_MAX = 200;
/** How far back the recent checks list reaches. */
export const RECENT_CHECK_DAYS = 7;

export type RoomStatus =
  | { kind: 'unchecked' }
  | { kind: 'saved-on-device' }
  | { kind: 'attention'; count: number }
  | { kind: 'complete' };

export function localIsoDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The local calendar date `days` before `date` (calendar maths, DST-safe). */
export function localIsoDateDaysBefore(days: number, date = new Date()): string {
  return localIsoDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() - days));
}

export function roomLabel(room: Pick<RoomTrackRoom, 'id' | 'roomNumber' | 'name'> | undefined, roomId?: number): string {
  if (!room) return `Room ${roomId ?? ''}`.trim();
  return room.roomNumber || room.name || `Room ${room.id}`;
}

export function outcomeCount(values: RoomCheckValues): number {
  return ROOM_OUTCOMES.filter((outcome) => values[outcome.key]).length;
}

/** Active rooms for the chosen site (null = all sites), as the website lists them. */
export function visibleRooms(rooms: RoomTrackRoom[], siteId: number | null): RoomTrackRoom[] {
  return rooms.filter((room) => room.active && (siteId === null || room.siteId === siteId));
}

/** Today's check per room. One check per room and day is stored. */
export function checksByRoom(checks: RoomTrackCheck[], date: string): Map<number, RoomTrackCheck> {
  const byRoom = new Map<number, RoomTrackCheck>();
  for (const check of checks) {
    if (check.checkDate.slice(0, 10) === date && !byRoom.has(check.roomId)) byRoom.set(check.roomId, check);
  }
  return byRoom;
}

/** Rooms with a check for `date` saved on this device and not yet confirmed. */
export function roomsSavedOnDevice(entries: { body: Record<string, unknown> }[], date: string): Set<number> {
  const ids = new Set<number>();
  for (const entry of entries) {
    if (entry.body.checkDate === date && typeof entry.body.roomId === 'number') ids.add(entry.body.roomId);
  }
  return ids;
}

export function roomStatus(check: RoomTrackCheck | undefined, savedOnDevice: boolean): RoomStatus {
  if (check) {
    const count = outcomeCount(check);
    return count === ROOM_OUTCOMES.length ? { kind: 'complete' } : { kind: 'attention', count };
  }
  return savedOnDevice ? { kind: 'saved-on-device' } : { kind: 'unchecked' };
}

/** Recent checks for the chosen site (null = all sites), newest first. */
export function recentChecks(checks: RoomTrackCheck[], siteId: number | null, limit = 20): RoomTrackCheck[] {
  return checks
    .filter((check) => siteId === null || check.siteId === siteId)
    .sort((a, b) => (a.checkDate < b.checkDate ? 1 : a.checkDate > b.checkDate ? -1 : b.id - a.id))
    .slice(0, limit);
}

/** The POST /room-track/checks body, or a message explaining what to fix. */
export function buildRoomCheckBody(input: {
  room: RoomTrackRoom;
  checkDate: string;
  values: RoomCheckValues;
  notes: string;
  checkedBy: string;
}): { body: Record<string, unknown> } | { error: string } {
  if (!input.room.active) return { error: 'This room has been archived and cannot receive new checks.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.checkDate)) return { error: 'The check date is not valid.' };
  const notes = input.notes.trim();
  const checkedBy = input.checkedBy.trim();
  if (notes.length > ROOM_NOTES_MAX) return { error: `Notes must be ${ROOM_NOTES_MAX.toLocaleString('en-GB')} characters or fewer.` };
  if (checkedBy.length > ROOM_CHECKED_BY_MAX) return { error: `Checked by must be ${ROOM_CHECKED_BY_MAX} characters or fewer.` };
  return {
    body: {
      roomId: input.room.id,
      checkDate: input.checkDate,
      siteId: input.room.siteId ?? null,
      clean: input.values.clean,
      tidy: input.values.tidy,
      toStandard: input.values.toStandard,
      notes: notes || null,
      checkedBy: checkedBy || null,
    },
  };
}
