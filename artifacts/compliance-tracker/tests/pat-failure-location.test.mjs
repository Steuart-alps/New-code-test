import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "pat-failure-location-"));
try {
  const outfile = path.join(dir, "failure-location.mjs");
  await build({
    entryPoints: [path.join(root, "src/components/pat-track/failure-location.ts")],
    outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent",
  });
  const { mapFailure, failureLocationDisplay, failureUpdateBody } = await import(pathToFileURL(outfile).href);

  // Realistic GET /api/pat-track/failures row after the room was renamed.
  const renamed = mapFailure({
    id: 7, certificate_id: 3, room_id: 12, location_text: "Room 101", room_name_snapshot: "Room 101",
    room_name: "Room 101", current_room_name: "Suite 201", snapshot_source: "recorded",
    appliance_name: "Kettle", action_taken: "Removed", resolution: "Awaiting part", resolved_date: null,
    certificate_ref: "CERT-1", corrected_location_text: null, correction_count: 0,
  });
  const renamedView = failureLocationDisplay(renamed);
  assert.equal(renamedView.recorded, "Room 101", "the recorded location is the evidence");
  assert.equal(renamedView.provenance, null);
  assert.equal(renamedView.currentRoom, "Room now named Suite 201");
  assert.equal(renamedView.correction, null);

  // An older API returned only the live register name as room_name: never treat it as recorded.
  const olderApi = mapFailure({ id: 8, certificate_id: 3, room_id: 12, location_text: null, room_name: "Suite 201", appliance_name: "Lamp" });
  assert.equal(olderApi.roomNumber, null);
  assert.equal(olderApi.snapshotSource, "legacy_unavailable");
  assert.equal(failureLocationDisplay(olderApi).recorded, "No location recorded");
  assert.match(failureLocationDisplay(olderApi).provenance, /not available/);

  for (const [source, pattern] of [["legacy_backfill", /not verified/], ["legacy_edit_recapture", /later edit/]]) {
    const view = failureLocationDisplay(mapFailure({ id: 9, certificate_id: 3, room_id: 12, location_text: "Room 101", room_name_snapshot: "Room 101", snapshot_source: source, appliance_name: "Fan" }));
    assert.equal(view.recorded, "Room 101");
    assert.match(view.provenance, pattern, `${source} must stay qualified`);
  }

  const corrected = mapFailure({
    id: 10, certificate_id: 3, room_id: null, location_text: "Plant cupboard", room_name_snapshot: "Plant cupboard",
    snapshot_source: "recorded", appliance_name: "Pump", corrected_location_text: "Boiler room",
    correction_reason: "Original sheet", correction_count: "1",
  });
  const correctedView = failureLocationDisplay(corrected);
  assert.equal(correctedView.recorded, "Plant cupboard", "a correction is shown beside, not instead of, the original");
  assert.equal(correctedView.correction, "Corrected to Boiler room (Original sheet)");
  assert.equal(correctedView.currentRoom, null);
  assert.equal(corrected.correctionCount, 1);

  // Ordinary edits re-send the recorded identity untouched and leave resolution text alone.
  const body = failureUpdateBody(renamed, { appliance: " Kettle ", actionTaken: "", resolvedDate: "2026-10-09" });
  assert.deepEqual(body, {
    certificateId: 3, roomId: 12, locationText: "Room 101", applianceName: "Kettle", actionTaken: null, resolvedDate: "2026-10-09",
  });
  assert.equal("resolution" in body, false);
  console.log("PAT failure location normalization checks passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
