// The sound level heard on a weekly fire alarm test. BS 5839-1 asks for at
// least 65 dB(A) in general areas and 75 dB(A) at the bedhead where people
// sleep. A reading from a sound meter below the limit is a problem; a phone
// microphone reading is only a rough guide, so a low one flags a possible
// problem to check with a meter and a high one proves nothing.
// The web app mirrors these limits (compliance-tracker src/lib/fire-sound-level.ts).

export const SOUND_LEVEL_MIN_DB = { general: 65, bedhead: 75 } as const;
export const SOUND_LEVEL_METHODS = ["meter", "phone"] as const;
export type SoundLevelMethod = (typeof SOUND_LEVEL_METHODS)[number];

export function soundLevelMinimum(bedhead: boolean | null | undefined): number {
  return bedhead ? SOUND_LEVEL_MIN_DB.bedhead : SOUND_LEVEL_MIN_DB.general;
}

/** "62 dB at a bedhead (needs 75, phone reading)" for reports, or null when no reading was taken. */
export function soundLevelLowText(row: { soundLevelDb: number | null; soundLevelBedhead: boolean | null; soundLevelMethod: string | null }): string | null {
  if (row.soundLevelDb == null) return null;
  const minimum = soundLevelMinimum(row.soundLevelBedhead);
  if (row.soundLevelDb >= minimum) return null;
  const where = row.soundLevelBedhead ? " at a bedhead" : "";
  const how = row.soundLevelMethod === "phone" ? ", phone reading, check with a meter" : "";
  return `${Math.round(row.soundLevelDb)} dB${where} (needs ${minimum}${how})`;
}
