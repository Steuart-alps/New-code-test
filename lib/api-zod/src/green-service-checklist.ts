/**
 * The checklist for a GreenTrack machine service done in house, so a service
 * by the club's own mechanic is recorded as fully as a contractor's job
 * sheet. Shared by the API (which checks every line is answered) and the web
 * form. Lines that do not apply to a machine (no coolant on an air-cooled
 * engine, no cutting units on a tractor) are answered "N/A".
 */

export const GREEN_SERVICE_DONE_BY = ["in_house", "contractor"] as const;
export type GreenServiceDoneBy = (typeof GREEN_SERVICE_DONE_BY)[number];

export const GREEN_SERVICE_RESULTS = ["done", "na", "problem"] as const;
export type GreenServiceResult = (typeof GREEN_SERVICE_RESULTS)[number];

export const GREEN_SERVICE_CHECKLIST = [
  { key: "engine_oil", label: "Engine oil and oil filter changed" },
  { key: "air_filter", label: "Air filter cleaned or replaced" },
  { key: "fuel_system", label: "Fuel filter and fuel lines checked" },
  { key: "plugs", label: "Spark plugs or glow plugs checked or replaced" },
  { key: "coolant", label: "Coolant level checked and radiator screen clean" },
  { key: "hydraulics", label: "Hydraulic oil level, hoses and filters checked, no leaks" },
  { key: "greasing", label: "All grease points greased" },
  { key: "belts_chains", label: "Belts, chains and drives checked and tensioned" },
  { key: "tyres", label: "Tyres or tracks: pressures and condition" },
  { key: "cutting_units", label: "Cutting units: cylinders or blades sharpened, backlapped, height of cut set" },
  { key: "battery_electrics", label: "Battery, lights, beacon and horn working" },
  { key: "brakes", label: "Brakes and parking brake tested" },
  { key: "safety_devices", label: "Safety devices tested: seat switch, operator presence, PTO and blade interlocks, stop switch" },
  { key: "guards", label: "Guards, covers, ROPS and seat belt in place and sound" },
  { key: "test_run", label: "Test run: no leaks, unusual noise or vibration" },
] as const;

export type GreenServiceChecklistKey = (typeof GREEN_SERVICE_CHECKLIST)[number]["key"];

export interface GreenServiceChecklistLine {
  key: string;
  label: string;
  result: GreenServiceResult;
  note?: string | null;
}

const MAX_NOTE = 500;

/**
 * A checked in-house checklist, or the reason it cannot be saved. Every line
 * must be answered, and a problem needs a note saying what was found.
 */
export function parseGreenServiceChecklist(value: unknown):
  { ok: true; lines: GreenServiceChecklistLine[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "Answer every line of the service checklist" };
  const byKey = new Map<string, { result?: unknown; note?: unknown }>();
  for (const entry of value) {
    if (entry && typeof entry === "object" && typeof (entry as any).key === "string") byKey.set((entry as any).key, entry as any);
  }
  const lines: GreenServiceChecklistLine[] = [];
  for (const item of GREEN_SERVICE_CHECKLIST) {
    const entry = byKey.get(item.key);
    const result = entry?.result;
    if (typeof result !== "string" || !(GREEN_SERVICE_RESULTS as readonly string[]).includes(result)) {
      return { ok: false, error: `Answer "${item.label}" (done, N/A or problem found)` };
    }
    const note = typeof entry?.note === "string" ? entry.note.trim().slice(0, MAX_NOTE) : "";
    if (result === "problem" && !note) return { ok: false, error: `Say what was wrong with "${item.label}"` };
    lines.push({ key: item.key, label: item.label, result: result as GreenServiceResult, note: note || null });
  }
  return { ok: true, lines };
}
