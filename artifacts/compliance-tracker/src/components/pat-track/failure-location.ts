// Normalizes /api/pat-track/failures rows. The recorded location is the
// evidence; the live room name and any supplemental correction are shown
// beside it and never replace it.

export type PatFailureSnapshotSource = "recorded" | "legacy_backfill" | "legacy_edit_recapture" | "legacy_unavailable";

export type Failure = {
  id: number;
  certificateId: number;
  roomId?: number | null;
  /** Room name recorded with the failure (not the live register name). */
  roomNumber?: string | null;
  locationText?: string | null;
  currentRoomName?: string | null;
  snapshotSource: PatFailureSnapshotSource;
  correctedLocationText?: string | null;
  correctionReason?: string | null;
  correctedAt?: string | null;
  correctedByName?: string | null;
  correctionCount: number;
  appliance: string;
  actionTaken?: string | null;
  resolution?: string | null;
  resolvedDate?: string | null;
  certificateRef?: string | null;
};

const SOURCES: PatFailureSnapshotSource[] = ["recorded", "legacy_backfill", "legacy_edit_recapture", "legacy_unavailable"];

export function mapFailure(x: any): Failure {
  const source = SOURCES.includes(x.snapshot_source) ? x.snapshot_source : "legacy_unavailable";
  return {
    id: x.id,
    certificateId: x.certificate_id,
    roomId: x.room_id,
    // Older API builds returned the live register name as room_name, so it is
    // never used as the recorded room.
    roomNumber: x.room_name_snapshot ?? null,
    locationText: x.location_text,
    currentRoomName: x.current_room_name ?? null,
    snapshotSource: source,
    correctedLocationText: x.corrected_location_text ?? null,
    correctionReason: x.correction_reason ?? null,
    correctedAt: x.corrected_at ?? null,
    correctedByName: x.corrected_by_name ?? null,
    correctionCount: Number(x.correction_count ?? 0),
    appliance: x.appliance_name,
    actionTaken: x.action_taken,
    resolution: x.resolution ?? null,
    resolvedDate: x.resolved_date,
    certificateRef: x.certificate_ref,
  };
}

export type FailureLocationDisplay = {
  /** The location recorded with the failure. */
  recorded: string;
  /** Qualification shown when the recorded value was not captured at the time. */
  provenance: string | null;
  /** Latest explicit correction, shown alongside the recorded value. */
  correction: string | null;
  /** The room's current register name, only when it now differs. */
  currentRoom: string | null;
};

export function failureLocationDisplay(f: Failure): FailureLocationDisplay {
  const recorded = f.locationText || f.roomNumber || "No location recorded";
  const provenance = f.snapshotSource === "legacy_backfill"
    ? "Location filled from the room register during migration; not verified at the inspection date"
    : f.snapshotSource === "legacy_edit_recapture"
      ? "Recorded before location history was retained; the room name may reflect a later edit"
      : f.snapshotSource === "legacy_unavailable"
        ? "Original location not available from older records"
        : null;
  const correction = f.correctedLocationText
    ? `Corrected to ${f.correctedLocationText}${f.correctionReason ? ` (${f.correctionReason})` : ""}`
    : null;
  const roomAtRecording = f.roomNumber ?? f.locationText ?? null;
  const currentRoom = f.roomId && f.currentRoomName && f.currentRoomName !== roomAtRecording
    ? `Room now named ${f.currentRoomName}`
    : null;
  return { recorded, provenance, correction, currentRoom };
}

/** Body for an ordinary failure edit: the recorded identity is re-sent unchanged. */
export function failureUpdateBody(f: Failure, edit: { appliance: string; actionTaken: string; resolvedDate: string }) {
  return {
    certificateId: f.certificateId,
    roomId: f.roomId ?? null,
    locationText: f.locationText ?? null,
    applianceName: edit.appliance.trim(),
    actionTaken: edit.actionTaken.trim() || null,
    resolvedDate: edit.resolvedDate || null,
  };
}
