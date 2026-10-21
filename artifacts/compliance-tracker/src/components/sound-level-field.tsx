import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  measureWithPhone, phoneAdjustment, phoneMeterSupported, savePhoneAdjustment,
  SOUND_LEVEL_MIN_DB, soundLevelMinimum, soundLevelVerdict, type SoundLevelMethod,
} from "@/lib/fire-sound-level";

export interface SoundLevelValue {
  /** As typed; blank when no reading was taken. */
  db: string;
  method: SoundLevelMethod;
  bedhead: boolean;
}

export const EMPTY_SOUND_LEVEL: SoundLevelValue = { db: "", method: "meter", bedhead: false };

/** The request fields for a sound level (all null when none was taken). */
export function soundLevelRequest(value: SoundLevelValue) {
  const db = parseSoundLevel(value.db);
  return db === null
    ? { soundLevelDb: null, soundLevelMethod: null, soundLevelBedhead: null }
    : { soundLevelDb: db, soundLevelMethod: value.method, soundLevelBedhead: value.bedhead };
}

/** A typed level in dB, or null when blank or out of range (20 to 140). */
export function parseSoundLevel(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 20 && value <= 140 ? value : null;
}

/** What a reading means: shown on the form and in the log. */
export function SoundLevelVerdictText({ db, bedhead, method, className }: {
  db: number; bedhead: boolean | null | undefined; method: string | null | undefined; className?: string;
}) {
  const minimum = soundLevelMinimum(bedhead);
  const verdict = soundLevelVerdict(db, bedhead, method);
  const text = verdict === "low"
    ? method === "phone"
      ? `Possibly too quiet: needs at least ${minimum} dB. Check it with a sound meter.`
      : `Too quiet: needs at least ${minimum} dB. Tell your fire alarm engineer.`
    : verdict === "ok"
      ? `Loud enough (needs ${minimum} dB).`
      : `Rough guide only: a phone can't prove the alarm is loud enough (needs ${minimum} dB).`;
  return (
    <p className={cn("text-xs", verdict === "low" ? "text-rose-700 font-medium" : verdict === "ok" ? "text-emerald-700" : "text-muted-foreground", className)}
      data-testid="sound-level-verdict" data-verdict={verdict}>
      {text}
    </p>
  );
}

/**
 * The sound level heard on a weekly alarm test: typed in from a sound meter,
 * or measured roughly with this phone's microphone. Optional.
 */
export function SoundLevelField({ value, onChange }: { value: SoundLevelValue; onChange: (value: SoundLevelValue) => void }) {
  const [measuring, setMeasuring] = useState(false);
  const [live, setLive] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [maxedOut, setMaxedOut] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [meterReading, setMeterReading] = useState("");
  const stopRef = useRef<AbortController | null>(null);
  useEffect(() => () => stopRef.current?.abort(), []);

  const db = parseSoundLevel(value.db);
  const invalid = value.db.trim() !== "" && db === null;
  const setUp = phoneAdjustment() !== null;

  async function measure() {
    setProblem(null);
    setMaxedOut(false);
    setMeasuring(true);
    const controller = new AbortController();
    stopRef.current = controller;
    try {
      const result = await measureWithPhone({ seconds: 5, onLevel: level => setLive(Math.round(level)), signal: controller.signal });
      setMaxedOut(result.maxedOut);
      onChange({ ...value, db: String(result.db), method: "phone" });
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setProblem(err?.name === "NotAllowedError"
          ? "The microphone is blocked. Allow it for this site in your browser settings, or type the reading in."
          : "This phone couldn't take a reading. Type the reading in instead.");
      }
    } finally {
      setMeasuring(false);
      setLive(null);
      stopRef.current = null;
    }
  }

  function saveSetUp() {
    const meter = parseSoundLevel(meterReading);
    if (meter === null || db === null || value.method !== "phone") return;
    savePhoneAdjustment((phoneAdjustment() ?? 0) + (meter - db));
    onChange({ ...value, db: String(Math.round(meter)), method: "meter" });
    setSettingUp(false);
    setMeterReading("");
  }

  return (
    <div className="space-y-2 border border-border rounded-sm p-3 bg-muted/20" data-testid="sound-level-field">
      <div className="flex items-center gap-2">
        <Volume2 className="w-4 h-4 text-primary flex-shrink-0" />
        <p className="text-sm font-medium">Sound level <span className="text-muted-foreground text-xs font-normal">optional</span></p>
      </div>
      <p className="text-xs text-muted-foreground">
        While the alarm sounds, read a sound meter or measure with this phone. At least {SOUND_LEVEL_MIN_DB.general} dB is needed in general areas, and {SOUND_LEVEL_MIN_DB.bedhead} dB at the bedhead where people sleep.
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex items-center gap-1.5">
          <Input value={value.db} inputMode="decimal" aria-label="Sound level in dB" placeholder="e.g. 82"
            className={cn("h-9 w-24 rounded-sm", invalid && "border-rose-400")} data-testid="input-sound-level"
            onChange={e => onChange({ ...value, db: e.target.value.replace(/[^\d.]/g, "").slice(0, 5) })} />
          <span className="text-sm text-muted-foreground">dB</span>
        </div>
        <Select value={value.method} onValueChange={v => onChange({ ...value, method: v as SoundLevelMethod })}>
          <SelectTrigger className="h-9 w-auto min-w-[10rem] rounded-sm text-xs" aria-label="How it was measured" data-testid="select-sound-level-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="meter">From a sound meter</SelectItem>
            <SelectItem value="phone">From a phone (rough guide)</SelectItem>
          </SelectContent>
        </Select>
        {phoneMeterSupported && (
          measuring ? (
            <Button type="button" variant="destructive" size="sm" className="h-9" onClick={() => stopRef.current?.abort()}>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> {live !== null ? `${live} dB` : "Listening"}… Stop
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={measure} data-testid="button-measure-sound">
              <Mic className="w-3.5 h-3.5 mr-1.5" /> Measure with this phone
            </Button>
          )
        )}
      </div>
      {measuring && <p className="text-xs text-muted-foreground" aria-live="polite">Hold the phone up, away from your body, for 5 seconds while the alarm sounds.</p>}
      {invalid && <p className="text-xs text-rose-700">Enter a level between 20 and 140 dB.</p>}
      {problem && <p role="alert" className="text-xs text-rose-700">{problem}</p>}
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <Checkbox checked={value.bedhead} onCheckedChange={checked => onChange({ ...value, bedhead: checked === true })}
          data-testid="checkbox-sound-level-bedhead" />
        Taken at a bedhead in a sleeping area (needs {SOUND_LEVEL_MIN_DB.bedhead} dB)
      </label>
      {db !== null && <SoundLevelVerdictText db={db} bedhead={value.bedhead} method={value.method} />}
      {maxedOut && db !== null && value.method === "phone" && (
        <p className="text-xs text-muted-foreground">The phone's microphone reached its limit, so the real level may be higher.</p>
      )}
      {value.method === "phone" && db !== null && !measuring && (
        settingUp ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span>A sound meter next to this phone showed</span>
            <Input value={meterReading} inputMode="decimal" aria-label="Sound meter reading in dB" className="h-8 w-20 rounded-sm text-xs"
              onChange={e => setMeterReading(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))} />
            <span>dB</span>
            <Button type="button" size="sm" className="h-8" disabled={parseSoundLevel(meterReading) === null} onClick={saveSetUp}>Set up this phone</Button>
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setSettingUp(false)}>Cancel</Button>
          </div>
        ) : (
          <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => setSettingUp(true)}>
            {setUp ? "Reading looks wrong? Set this phone up against a sound meter again" : "This phone isn't set up yet, so readings could be well out. Set it up against a sound meter"}
          </button>
        )
      )}
    </div>
  );
}
