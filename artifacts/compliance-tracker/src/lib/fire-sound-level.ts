// The sound level heard on a weekly fire alarm test (api-server
// lib/fireSoundLevel.ts has the same limits). BS 5839-1 asks for at least
// 65 dB(A) in general areas and 75 dB(A) at the bedhead where people sleep.
//
// "Measure" uses the phone's own microphone, in the browser, at no cost. Phone
// microphones are not calibrated, so it is a rough guide: a low reading flags
// a possible problem to check with a sound meter, and a high one proves
// nothing. Each phone can be set up against a meter once (the adjustment is
// kept on that phone only).

export const SOUND_LEVEL_MIN_DB = { general: 65, bedhead: 75 } as const;
export type SoundLevelMethod = "meter" | "phone";

export function soundLevelMinimum(bedhead: boolean | null | undefined): number {
  return bedhead ? SOUND_LEVEL_MIN_DB.bedhead : SOUND_LEVEL_MIN_DB.general;
}

export type SoundLevelVerdict = "low" | "ok" | "rough_ok";

/** Below the limit is "low" however it was taken; a phone can only suggest "rough_ok". */
export function soundLevelVerdict(db: number, bedhead: boolean | null | undefined, method: string | null | undefined): SoundLevelVerdict {
  if (db < soundLevelMinimum(bedhead)) return "low";
  return method === "phone" ? "rough_ok" : "ok";
}

// Typical phone microphones read about -26 dBFS for a 94 dB sound, so full
// scale is roughly 120 dB. Phones differ, which is what the set-up adjusts.
const FULL_SCALE_DB = 120;
const ADJUST_KEY = "complytrack:sound-meter-adjust-db";

/** This phone's set-up adjustment in dB (0 when never set up). */
export function phoneAdjustment(): number | null {
  try {
    const raw = window.localStorage.getItem(ADJUST_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function savePhoneAdjustment(value: number | null) {
  try {
    if (value === null) window.localStorage.removeItem(ADJUST_KEY);
    else window.localStorage.setItem(ADJUST_KEY, String(Math.round(value * 10) / 10));
  } catch {
    // Private browsing: the adjustment lasts until the page closes.
  }
}

export const phoneMeterSupported = typeof navigator !== "undefined"
  && !!navigator.mediaDevices?.getUserMedia
  && typeof window !== "undefined"
  && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);

export interface PhoneMeasurement {
  /** Average level over the measurement, adjusted for this phone. */
  db: number;
  /** The microphone hit its limit, so the real level may be higher. */
  maxedOut: boolean;
}

/**
 * Listen for `seconds` and return the average (energy-averaged) level. Low
 * rumble (ventilation, traffic) is filtered out, roughly as a sound meter's
 * A-weighting does; alarm sounders are well above it. `onLevel` gets the
 * level about ten times a second while listening.
 */
export async function measureWithPhone(
  { seconds = 5, onLevel, signal }: { seconds?: number; onLevel?: (db: number) => void; signal?: AbortSignal } = {},
): Promise<PhoneMeasurement> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const Context = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Context();
  try {
    if (context.state === "suspended") await context.resume();
    const source = context.createMediaStreamSource(stream);
    const rumble = context.createBiquadFilter();
    rumble.type = "highpass";
    rumble.frequency.value = 200;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(rumble).connect(analyser);
    // The unfiltered signal shows when the microphone hits its limit.
    const raw = context.createAnalyser();
    raw.fftSize = 2048;
    source.connect(raw);
    const samples = new Float32Array(analyser.fftSize);
    const rawSamples = new Float32Array(raw.fftSize);
    const offset = FULL_SCALE_DB + (phoneAdjustment() ?? 0);
    const toDb = (meanSquare: number) => 10 * Math.log10(Math.max(meanSquare, 1e-12)) + offset;
    let energy = 0;
    let blocks = 0;
    let maxedOut = false;
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
      await new Promise(resolve => setTimeout(resolve, 100));
      analyser.getFloatTimeDomainData(samples);
      raw.getFloatTimeDomainData(rawSamples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      if (!maxedOut) maxedOut = rawSamples.some(sample => Math.abs(sample) >= 0.99);
      const meanSquare = sum / samples.length;
      energy += meanSquare;
      blocks += 1;
      onLevel?.(toDb(meanSquare));
    }
    return { db: Math.round(toDb(energy / Math.max(blocks, 1))), maxedOut };
  } finally {
    stream.getTracks().forEach(track => track.stop());
    void context.close();
  }
}
