import { BedDouble, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A site's answers; null until answered. */
export type FireWalkAnswers = { sleepingAccommodation: boolean | null; nightPorter: boolean | null };

/** What the answers mean for the site's fire walks, in a few words. */
export function fireWalkSummary(answers: Partial<FireWalkAnswers>): string | null {
  if (answers.sleepingAccommodation == null) return null;
  if (!answers.sleepingAccommodation) return "No sleeping accommodation";
  if (answers.nightPorter === true) return "Sleeping accommodation · night porter (fire walks 22:00, 02:00, 06:00)";
  if (answers.nightPorter === false) return "Sleeping accommodation · no night porter (fire walk on opening and closing checks)";
  return "Sleeping accommodation · night porter not answered";
}

function YesNo({ id, value, onChange, disabled }: {
  id: string; value: boolean | null; onChange: (value: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-labelledby={id}>
      {([[true, "Yes"], [false, "No"]] as const).map(([option, label]) => (
        <button key={label} type="button" role="radio" aria-checked={value === option} disabled={disabled}
          onClick={() => onChange(option)}
          className={cn(
            "min-w-12 rounded-md border px-3 py-1 text-sm font-medium transition-colors disabled:opacity-60",
            value === option ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:border-primary/50",
          )}>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * "Sleeping accommodation?" and, if yes, "Night porter?". The answers decide
 * the site's fire walks: the FireTrack escape route sign-off only applies
 * with sleeping accommodation; a night porter walks at 22:00, 02:00 and
 * 06:00; without one the fire walk goes on the opening and closing checks.
 */
export function SiteFireWalkQuestions({ idPrefix, value, onChange, disabled, className }: {
  idPrefix: string;
  value: FireWalkAnswers;
  onChange: (value: FireWalkAnswers) => void;
  disabled?: boolean;
  className?: string;
}) {
  const sleepingId = `${idPrefix}-sleeping`;
  const porterId = `${idPrefix}-porter`;
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={sleepingId} className="flex items-center gap-1.5 text-sm">
          <BedDouble className="h-4 w-4 text-primary shrink-0" /> Sleeping accommodation (bedrooms, staff or guest rooms)?
        </span>
        <YesNo id={sleepingId} value={value.sleepingAccommodation} disabled={disabled}
          onChange={(sleepingAccommodation) => onChange({ sleepingAccommodation, nightPorter: sleepingAccommodation ? value.nightPorter : null })} />
      </div>
      {value.sleepingAccommodation && (
        <div className="flex flex-wrap items-center justify-between gap-2 pl-5">
          <span id={porterId} className="flex items-center gap-1.5 text-sm">
            <Moon className="h-4 w-4 text-primary shrink-0" /> Night porter on duty overnight?
          </span>
          <YesNo id={porterId} value={value.nightPorter} disabled={disabled}
            onChange={(nightPorter) => onChange({ ...value, nightPorter })} />
        </div>
      )}
      {value.sleepingAccommodation != null && (
        <p className="text-xs text-muted-foreground">
          {!value.sleepingAccommodation
            ? "No escape route sign-off or night fire walks for this site."
            : value.nightPorter === true
              ? "FireTrack asks for the escape route sign-off and three signed night fire walks, at 22:00, 02:00 and 06:00. A missed walk is chased the next morning."
              : value.nightPorter === false
                ? "FireTrack asks for the escape route sign-off, and a fire walk is added to this site's opening and closing checks."
                : "FireTrack asks for the escape route sign-off. Say whether there is a night porter to set up the night fire walks."}
        </p>
      )}
    </div>
  );
}
