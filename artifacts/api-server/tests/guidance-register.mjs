import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const output = "/tmp/complytrack-uk-guidance-test.mjs";
await build({
  entryPoints: [new URL("../src/lib/ukComplianceGuidance.ts", import.meta.url).pathname],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
});

const { UK_COMPLIANCE_GAPS, UK_COMPLIANCE_GUIDANCE } = await import(`${pathToFileURL(output).href}?${Date.now()}`);
const requiredTracks = [
  "DailyTrack AM / DailyTrack PM", "KitchenTrack", "FireTrack", "LegionellaTrack",
  "AquaTrack / PoolTrack", "TubTrack / HotTubTrack", "PATtrack", "PestTrack",
  "FixTrack", "PremisesTrack", "RoomTrack", "DocTrack", "SafeTrack", "TrainTrack",
  "TreeTrack", "BikeTrack", "GreenTrack", "SwimTrack", "IncidentTrack",
];
const allowedClassifications = new Set([
  "Legislation", "Approved Code of Practice", "Official guidance",
  "Industry guidance", "British Standard / best practice",
]);
const coveredTracks = new Set(UK_COMPLIANCE_GUIDANCE.map(source => source.track));

for (const track of requiredTracks) {
  if (!coveredTracks.has(track)) throw new Error(`Missing source coverage for ${track}`);
}
for (const source of UK_COMPLIANCE_GUIDANCE) {
  if (!allowedClassifications.has(source.classification)) throw new Error(`Invalid classification for ${source.title}`);
  for (const field of ["jurisdiction", "applicability", "owner", "reviewNote"]) {
    if (!source[field]?.trim()) throw new Error(`Missing ${field} for ${source.title}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.reviewedAt)) throw new Error(`Invalid review date for ${source.title}`);
  if (!source.url.startsWith("https://")) throw new Error(`Non-HTTPS source for ${source.title}`);
}
if (!UK_COMPLIANCE_GAPS.some(gap => gap.priority === "high")) throw new Error("No high-priority implementation gaps");
if (!UK_COMPLIANCE_GAPS.every(gap => gap.tracks.length && gap.recommendedControl?.trim())) {
  throw new Error("Comparison gaps must identify tracks and an actionable control");
}

console.log(`UK guidance register: ${UK_COMPLIANCE_GUIDANCE.length} sources, ${UK_COMPLIANCE_GAPS.length} actionable gaps`);