import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "pat-replacement-identity-"));
try {
  const outfile = path.join(dir, "replacement-identity.mjs");
  await build({
    entryPoints: [path.join(root, "src/components/pat-track/replacement-identity.ts")],
    outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent",
  });
  const { mapReplacement, replacementIdentityNote } = await import(pathToFileURL(outfile).href);

  // Realistic GET /api/pat-track/replacements row after a room rename.
  const renamed = mapReplacement({
    id: 4, client_id: 1, room_id: 9, appliance_name: "Toaster", replaced_on: "2026-01-02", replacement_details: "New toaster",
    notes: null, room_name_snapshot: "Room 101", site_id_snapshot: 3, site_name_snapshot: "North", snapshot_source: "recorded",
    room_name: "Room 101", current_room_name: "Suite 201", site_id: 3,
  });
  assert.equal(renamed.recordedRoomName, "Room 101");
  assert.equal(renamed.currentRoomName, "Suite 201");
  assert.equal(renamed.recordedSiteName, "North");
  assert.equal(replacementIdentityNote(renamed, "Suite 201"), "Recorded in Room 101");
  assert.equal(replacementIdentityNote(renamed, "Room 101"), null, "no note when the room still has its recorded name");

  const legacy = mapReplacement({ id: 5, room_id: 9, appliance_name: "Kettle", room_name_snapshot: "Room 101", snapshot_source: "legacy_backfill" });
  assert.match(replacementIdentityNote(legacy, "Room 101"), /not verified/);
  const corrected = mapReplacement({ id: 6, room_id: 9, appliance_name: "Fan", room_name_snapshot: "Room 102", snapshot_source: "corrected" });
  assert.equal(replacementIdentityNote(corrected, "Suite 201"), "Recorded in Room 102; room corrected after recording");

  // An older API only returned the live name: it must not be presented as recorded.
  const olderApi = mapReplacement({ id: 7, room_id: 9, appliance_name: "Lamp", room_name: "Suite 201" });
  assert.equal(olderApi.recordedRoomName, null);
  assert.equal(olderApi.snapshotSource, "legacy_unavailable");
  assert.match(replacementIdentityNote(olderApi, "Suite 201"), /not available/);
  console.log("PAT replacement identity normalization checks passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
