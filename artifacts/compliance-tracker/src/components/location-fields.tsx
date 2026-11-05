import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiFetch as sharedApiFetch } from "@/lib/api";
import { ExternalLink, Loader2, MapPin } from "lucide-react";

export interface LocationValue { location: string; what3words: string; latitude: number | null; longitude: number | null }

/** A what3words address as typed ("///Filled.Count.Soap", "filled count soap") as "filled.count.soap", or null. */
export function normaliseWhat3Words(value: string): string | null {
  const words = value.trim().replace(/^\/+/u, "").replace(/\u200b/gu, "").toLowerCase()
    .split(/[.\s。．｡・]+/u).filter(Boolean);
  return words.length === 3 && words.every(w => /^\p{L}+$/u.test(w)) ? words.join(".") : null;
}

export function What3WordsLink({ words }: { words: string | null | undefined }) {
  if (!words) return null;
  return (
    <a href={`https://what3words.com/${words}`} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 hover:underline"
      onClick={e => e.stopPropagation()}>
      ///{words} <ExternalLink className="w-3 h-3" />
    </a>
  );
}

export function MapLink({ latitude, longitude }: { latitude?: number | null; longitude?: number | null }) {
  if (latitude == null || longitude == null) return null;
  return (
    <a href={`https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
      onClick={e => e.stopPropagation()}>
      <MapPin className="w-3 h-3" /> Map
    </a>
  );
}

/**
 * Where something is: the place in words, its what3words address and, when
 * a phone saved one, its GPS spot. Used by TreeTrack (trees, inspections)
 * and IncidentTrack. Automatic words come with the AI add-on (/api/w3w/convert);
 * everyone else saves the GPS spot free and types the words in.
 * `locationInput` replaces the plain place box (incidents offer a list).
 */
export function LocationFields({ location, what3words, latitude, longitude, onChange, locationLabel, what3wordsLabel,
  locationPlaceholder = "e.g. By the 9th tee, car park perimeter, east boundary", locationInput, idPrefix = "" }: {
  location: string; what3words: string; latitude: number | null; longitude: number | null;
  onChange: (patch: Partial<LocationValue>) => void;
  locationLabel: ReactNode; what3wordsLabel: ReactNode;
  locationPlaceholder?: string; locationInput?: ReactNode; idPrefix?: string;
}) {
  const { toast } = useToast();
  const [locating, setLocating] = useState(false);
  const words = what3words.trim() ? normaliseWhat3Words(what3words) : null;

  function captureMyLocation() {
    if (!navigator.geolocation) {
      toast({ title: "Location unavailable", description: "This browser can't share its location.", variant: "destructive" });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const latitude = Math.round(pos.coords.latitude * 1e6) / 1e6;
        const longitude = Math.round(pos.coords.longitude * 1e6) / 1e6;
        onChange({ latitude, longitude });
        // The three words are filled in automatically for businesses with the
        // AI add-on; others save the GPS spot and type the words in.
        let found: string | null = null;
        let needsAi = false;
        try {
          const res = await sharedApiFetch(`/w3w/convert?lat=${latitude}&lng=${longitude}`);
          if (res.ok) found = ((await res.json()) as { words?: string }).words ?? null;
          else if (res.status === 403) needsAi = ((await res.json().catch(() => ({}))) as { code?: string }).code === "W3W_NEEDS_AI";
        } catch { /* the GPS spot is saved either way */ }
        if (found) onChange({ what3words: found });
        toast({
          title: "Location saved",
          description: found ? `///${found}`
            : needsAi ? "GPS spot saved. Type the three words from the free what3words app, or add the AI add-on in Settings to fill them in automatically."
            : "GPS spot saved. Add the what3words address from the what3words app if you have it.",
        });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        const msg = err.code === 1 ? "Location permission denied." : err.code === 2 ? "Location unavailable." : "Location timed out.";
        toast({ title: "Couldn't get your location", description: msg, variant: "destructive" });
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label htmlFor={`${idPrefix}location`}>{locationLabel}</Label>
          <button type="button" onClick={captureMyLocation} disabled={locating}
            className="flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {locating ? <Loader2 className="w-3 h-3 animate-spin" /> : <MapPin className="w-3 h-3" />}
            {locating ? "Getting location…" : "Use my location"}
          </button>
        </div>
        {locationInput ?? (
          <Input id={`${idPrefix}location`} dictation placeholder={locationPlaceholder}
            value={location} onChange={e => onChange({ location: e.target.value })} className="rounded-sm" />
        )}
        {latitude != null && longitude != null && (
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span>GPS {latitude.toFixed(5)}, {longitude.toFixed(5)}</span>
            <MapLink latitude={latitude} longitude={longitude} />
            <button type="button" className="hover:underline" onClick={() => onChange({ latitude: null, longitude: null })}>Clear</button>
          </div>
        )}
      </div>
      <div>
        <Label htmlFor={`${idPrefix}what3words`}>{what3wordsLabel}</Label>
        <div className="relative mt-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-rose-600">///</span>
          <Input id={`${idPrefix}what3words`} placeholder="filled.count.soap" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            value={what3words.replace(/^\/+/, "")} onChange={e => onChange({ what3words: e.target.value })} className="pl-9 rounded-sm" />
        </div>
        {what3words.trim() && !words ? (
          <p className="text-xs text-rose-600 mt-1">Three words with dots between them, like filled.count.soap</p>
        ) : words ? (
          <div className="mt-1"><What3WordsLink words={words} /></div>
        ) : (
          <p className="text-xs text-muted-foreground mt-1">
            From the free what3words app or <a href="https://what3words.com" target="_blank" rel="noopener noreferrer" className="underline">what3words.com</a>, so anyone can find the exact spot.
          </p>
        )}
      </div>
    </>
  );
}
