import { ExternalLink } from "lucide-react";
import { KITCHEN_TEMPERATURE_GUIDANCE, kitchenTemperatureGuidance, type FoodJurisdiction } from "@workspace/api-client-react";
import { sortByLabel } from "@/lib/sort-options";

const GROUPS = ["United Kingdom", "Other countries"] as const;

/** <option>s for every country with KitchenTrack temperature guidance. */
export function FoodJurisdictionOptions() {
  return <>
    {GROUPS.map(group => <optgroup key={group} label={group}>
      {sortByLabel(Object.values(KITCHEN_TEMPERATURE_GUIDANCE).filter(entry => entry.group === group), entry => entry.name)
        .map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </optgroup>)}
  </>;
}

/** Where a country's starting values come from, and how far to trust them. */
export function KitchenGuidanceNote({ jurisdiction }: { jurisdiction: FoodJurisdiction | string }) {
  const guidance = kitchenTemperatureGuidance(jurisdiction);
  return <div className="space-y-1.5 rounded-sm border bg-muted/40 p-3 text-xs" data-testid="kitchen-guidance-note">
    <p>
      <span className="font-medium">{guidance.name}: </span>
      {guidance.source
        ? <a className="inline-flex items-center gap-1 underline" href={guidance.source.url} target="_blank" rel="noreferrer">
          {guidance.authority}<ExternalLink className="h-3 w-3" aria-hidden />
        </a>
        : guidance.authority}
    </p>
    {!guidance.reviewed && <p className="text-amber-700 dark:text-amber-400">
      Starting point only: these values come from published guidance and have not yet been checked by a food-safety professional in {guidance.id === "other" ? "your country" : guidance.name}. Check them with your local food authority before you rely on them.
    </p>}
    {guidance.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
      {guidance.notes.map(note => <li key={note}>{note}</li>)}
    </ul>}
  </div>;
}
