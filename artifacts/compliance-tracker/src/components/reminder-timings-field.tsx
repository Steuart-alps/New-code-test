import {
  DAYS_BEFORE_CHOICES,
  NEXT_WEEK,
  OVERDUE_EVERY_CHOICES,
  REMINDER_TYPES,
  defaultReminderTiming,
  type ReminderTiming,
  type ReminderType,
} from "@workspace/api-zod/reminder-timings";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Stored timings: only the types changed from their default. */
export type ReminderTimings = Record<string, ReminderTiming>;

export function parseReminderTimings(raw: string | null | undefined): ReminderTimings {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ReminderTimings : {};
  } catch {
    return {};
  }
}

const OFF = "off";

const daysBeforeLabel = (days: number) =>
  days === 0 ? "On the day" : days === 1 ? "1 day before" : `${days} days before`;

const overdueLabel = (days: number) =>
  days === 0 ? "Once, the day after" : days === 1 ? "Every day" : days === 7 ? "Every week" : `Every ${days} days`;

const sameTiming = (a: ReminderTiming, b: ReminderTiming) =>
  a.daysBefore === b.daysBefore && a.overdueEvery === b.overdueEvery;

const withValue = (choices: readonly number[], value: number | null) =>
  value == null || choices.includes(value) ? [...choices] : [...choices, value].sort((a, b) => a - b);

/**
 * One row per reminder type: how many days before it is due the person gets
 * it in their 8am email, and how often it repeats once overdue.
 */
export function ReminderTimingsField({
  value,
  onChange,
  contractorLeadDays,
}: {
  value: ReminderTimings;
  onChange: (next: ReminderTimings) => void;
  /** The contractor lead time setting: the contractor row's default. */
  contractorLeadDays: number;
}) {
  const defaultFor = (type: ReminderType): ReminderTiming =>
    type.key === "contractors"
      ? { ...defaultReminderTiming(type), daysBefore: contractorLeadDays }
      : defaultReminderTiming(type);

  const update = (type: ReminderType, timing: ReminderTiming) => {
    const next = { ...value };
    if (sameTiming(timing, defaultFor(type))) delete next[type.key];
    else next[type.key] = timing;
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      <Label>Reminder timings</Label>
      <p className="text-xs text-muted-foreground">
        When each person is reminded about their own work, by type, in their 8am email. "Weekly" lists everything of that type
        due the following week in one email on Fridays instead. Actions raised on a track follow that track. Expiries are also
        reminded the day before. The defaults are 1 day before, then weekly when overdue.
      </p>
      <div className="rounded-md border border-border divide-y divide-border">
        <div className="hidden sm:grid sm:grid-cols-[1fr_11rem_11rem] gap-3 px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>Type</span>
          <span>Remind</span>
          <span>If overdue, remind again</span>
        </div>
        {REMINDER_TYPES.map((type) => {
          const fallback = defaultFor(type);
          const timing = value[type.key] ?? fallback;
          const off = timing.daysBefore == null;
          const daysBefore = typeof timing.daysBefore === "number" ? timing.daysBefore : null;
          const changed = value[type.key] != null;
          return (
            <div
              key={type.key}
              className="grid grid-cols-2 sm:grid-cols-[1fr_11rem_11rem] gap-x-3 gap-y-2 px-3 py-2 items-center"
              data-testid={`reminder-timing-${type.key}`}
            >
              <span className="col-span-2 sm:col-span-1 text-sm">
                {type.label}
                {changed && <span className="ml-2 text-xs text-muted-foreground">(changed)</span>}
              </span>
              <Select
                value={off ? OFF : String(timing.daysBefore)}
                onValueChange={(next) =>
                  update(type, { ...timing, daysBefore: next === OFF ? null : next === NEXT_WEEK ? NEXT_WEEK : Number(next) })
                }
              >
                <SelectTrigger aria-label={`${type.label}: remind`} className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {withValue(DAYS_BEFORE_CHOICES, daysBefore).map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {daysBeforeLabel(days)}{days === fallback.daysBefore ? " (default)" : ""}
                    </SelectItem>
                  ))}
                  {!type.expiry && <SelectItem value={NEXT_WEEK}>Weekly: Friday email of next week</SelectItem>}
                  <SelectItem value={OFF}>Off</SelectItem>
                </SelectContent>
              </Select>
              {type.expiry ? (
                <span className="text-xs text-muted-foreground">Listed in the Owner update</span>
              ) : (
                <Select
                  value={String(timing.overdueEvery)}
                  disabled={off}
                  onValueChange={(next) => update(type, { ...timing, overdueEvery: Number(next) })}
                >
                  <SelectTrigger aria-label={`${type.label}: if overdue`} className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {withValue(OVERDUE_EVERY_CHOICES, timing.overdueEvery).map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {overdueLabel(days)}{days === fallback.overdueEvery ? " (default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        "Off" stops that type's reminder emails to people; it still shows in the Owner update. For staff training, the
        "Remind" choice also sets how far ahead each staff member's Monday training email looks, and Off stops it. Urgent items and new FixTrack issues
        are always emailed straight away.
      </p>
    </div>
  );
}
