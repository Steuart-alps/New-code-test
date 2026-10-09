// Normalizes /api/pat-track/replacements rows. A replacement is shown against
// the room and site recorded with it, never the room's current register name.

export type ReplacementSnapshotSource = "recorded" | "corrected" | "legacy_backfill" | "legacy_unavailable";

export type Replacement = {
  id: number;
  roomId: number;
  appliance: string;
  replacementAppliance?: string | null;
  replacedDate?: string | null;
  notes?: string | null;
  /** Room name recorded with the replacement. */
  recordedRoomName: string | null;
  recordedSiteName: string | null;
  currentRoomName: string | null;
  snapshotSource: ReplacementSnapshotSource;
};

const SOURCES: ReplacementSnapshotSource[] = ["recorded", "corrected", "legacy_backfill", "legacy_unavailable"];

export function mapReplacement(x: any): Replacement {
  return {
    id: x.id,
    roomId: x.room_id,
    appliance: x.appliance_name,
    replacementAppliance: x.replacement_details,
    replacedDate: x.replaced_on,
    notes: x.notes,
    // Older API builds returned the live name as room_name; only trust the snapshot.
    recordedRoomName: x.room_name_snapshot ?? null,
    recordedSiteName: x.site_name_snapshot ?? null,
    currentRoomName: x.current_room_name ?? null,
    snapshotSource: SOURCES.includes(x.snapshot_source) ? x.snapshot_source : "legacy_unavailable",
  };
}

/** Context shown beside a replacement listed under its room's current name. */
export function replacementIdentityNote(r: Replacement, currentRoomName: string): string | null {
  const parts: string[] = [];
  if (r.recordedRoomName && r.recordedRoomName !== currentRoomName) parts.push(`Recorded in ${r.recordedRoomName}`);
  if (r.snapshotSource === "legacy_backfill") parts.push("room name filled from the register during migration; not verified at the replacement date");
  if (r.snapshotSource === "legacy_unavailable") parts.push("room name at the replacement date is not available");
  if (r.snapshotSource === "corrected") parts.push("room corrected after recording");
  if (!parts.length) return null;
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
