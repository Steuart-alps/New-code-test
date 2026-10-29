import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useSiteFilter } from "@/hooks/use-own-site";

type CalendarKind =
  | "compliance_due" | "contractor_visit" | "contractor_insurance" | "contractor_indemnity"
  | "contractor_dbs" | "contractor_accreditation" | "fix_visit" | "pest_visit" | "training_expiry"
  | "coshh_track_due" | "asbestos_plan_review";

interface CalendarEntry {
  id: string;
  date: string;
  kind: CalendarKind;
  title: string;
  detail: string | null;
  siteName: string | null;
  href: string;
  status: "overdue" | "due" | "done";
}

interface Site { id: number; name: string }

/** Five colour groups; dot + chip classes for each. */
const GROUPS = {
  checks: { label: "Compliance checks", dot: "bg-blue-500", chip: "border-blue-200 bg-blue-50 text-blue-900" },
  visits: { label: "Contractor visits", dot: "bg-violet-500", chip: "border-violet-200 bg-violet-50 text-violet-900" },
  expiries: { label: "Contractor insurance, DBS and accreditations", dot: "bg-amber-500", chip: "border-amber-200 bg-amber-50 text-amber-900" },
  training: { label: "Training expiries", dot: "bg-pink-500", chip: "border-pink-200 bg-pink-50 text-pink-900" },
  registers: { label: "COSHH and asbestos reviews and checks", dot: "bg-teal-500", chip: "border-teal-200 bg-teal-50 text-teal-900" },
} as const;

const KIND_GROUP: Record<CalendarKind, keyof typeof GROUPS> = {
  compliance_due: "checks",
  contractor_visit: "visits",
  fix_visit: "visits",
  pest_visit: "visits",
  contractor_insurance: "expiries",
  contractor_indemnity: "expiries",
  contractor_dbs: "expiries",
  contractor_accreditation: "expiries",
  training_expiry: "training",
  coshh_track_due: "registers",
  asbestos_plan_review: "registers",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_IN_CELL = 3;

function iso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Monday-first weeks covering the whole month (5 or 6 rows). */
function monthGrid(year: number, month: number) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  const last = new Date(year, month + 1, 0);
  const end = new Date(year, month + 1, (7 - ((last.getDay() + 6) % 7)) - 1);
  const days: Date[] = [];
  for (let day = new Date(start); day <= end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    days.push(day);
  }
  return days;
}

function dayHeading(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function EntryChip({ entry, compact }: { entry: CalendarEntry; compact?: boolean }) {
  const group = GROUPS[KIND_GROUP[entry.kind]];
  return (
    <Link
      href={entry.href}
      title={[entry.title, entry.detail, entry.siteName].filter(Boolean).join(" · ")}
      className={cn(
        "block rounded border px-1.5 py-0.5 text-left hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        group.chip,
        entry.status === "overdue" && "border-red-400 ring-1 ring-red-300",
        entry.status === "done" && "opacity-60 line-through",
        compact ? "truncate text-[11px] leading-4" : "text-sm",
      )}
    >
      {entry.status === "overdue" && <span className="sr-only">Overdue: </span>}
      {entry.status === "done" && <span className="sr-only">Done: </span>}
      {compact ? entry.title : (
        <span className="flex items-start gap-2">
          {entry.status === "overdue" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            : entry.status === "done" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-700" />
              : <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", group.dot)} />}
          <span className="min-w-0">
            <span className="block font-medium">{entry.title}</span>
            {(entry.detail || entry.siteName) && (
              <span className="block text-xs opacity-80">{[entry.detail, entry.siteName].filter(Boolean).join(" · ")}</span>
            )}
          </span>
        </span>
      )}
    </Link>
  );
}

export default function CalendarPage() {
  const { user, activeClientId } = useAuth();
  const api = useActiveClientApi();
  const [month, setMonth] = useState(() => { const now = new Date(); return { year: now.getFullYear(), month: now.getMonth() }; });
  const [siteId, setSiteId] = useSiteFilter("all");
  const [sites, setSites] = useState<Site[]>([]);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const generation = useRef(0);

  const days = useMemo(() => monthGrid(month.year, month.month), [month]);
  const from = iso(days[0]);
  const to = iso(days[days.length - 1]);
  const today = iso(new Date());
  const monthLabel = new Date(month.year, month.month, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  useEffect(() => {
    setSiteId("all");
    api("/sites")
      .then(async (response) => (response.ok ? await response.json() as Site[] : []))
      .then((rows) => setSites(Array.isArray(rows) ? rows : []))
      .catch(() => setSites([]));
  }, [api, activeClientId, user?.id]);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setError("");
    const params = new URLSearchParams({ from, to });
    if (siteId !== "all") params.set("siteId", siteId);
    api(`/calendar?${params}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error || "The calendar could not be loaded");
        }
        return response.json() as Promise<{ entries: CalendarEntry[]; truncated: boolean }>;
      })
      .then((body) => {
        if (current !== generation.current) return;
        setEntries(body.entries); setTruncated(body.truncated);
      })
      .catch((problem) => {
        if (current !== generation.current) return;
        setEntries([]); setError(problem instanceof Error ? problem.message : "The calendar could not be loaded");
      })
      .finally(() => { if (current === generation.current) setLoading(false); });
  }, [api, from, to, siteId]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const entry of entries) map.set(entry.date, [...(map.get(entry.date) ?? []), entry]);
    return map;
  }, [entries]);
  const monthPrefix = `${month.year}-${String(month.month + 1).padStart(2, "0")}`;
  const monthDates = [...byDate.keys()].filter(date => date.startsWith(monthPrefix)).sort();
  const overdue = entries.filter(entry => entry.status === "overdue" && entry.date.startsWith(monthPrefix)).length;

  const shift = (delta: number) => {
    setSelected(null);
    setMonth(current => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };
  const goToday = () => {
    const now = new Date();
    setMonth({ year: now.getFullYear(), month: now.getMonth() });
    setSelected(iso(now));
  };

  return (
    <AppLayout title="Calendar">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft className="h-4 w-4" /></Button>
          <h2 className="min-w-[10rem] text-center text-lg font-bold" aria-live="polite">{monthLabel}</h2>
          <Button variant="outline" size="icon" aria-label="Next month" onClick={() => shift(1)}><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="ghost" size="sm" onClick={goToday}>Today</Button>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />}
        </div>
        <div className="w-full sm:w-64">
          <Select value={siteId} onValueChange={(value) => { setSiteId(value); setSelected(null); }}>
            <SelectTrigger aria-label="Site"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        Compliance check due dates, booked contractor visits, contractor insurance, DBS and accreditation expiries,
        and training expiries. Select an entry to open its record.
        {overdue > 0 && <span className="ml-1 font-medium text-red-700">{overdue} overdue this month.</span>}
      </p>

      <ul className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Key">
        {Object.values(GROUPS).map(group => (
          <li key={group.label} className="flex items-center gap-1.5"><span className={cn("h-2.5 w-2.5 rounded-full", group.dot)} />{group.label}</li>
        ))}
        <li className="flex items-center gap-1.5"><AlertTriangle className="h-3 w-3 text-red-600" />Overdue (red outline)</li>
      </ul>

      {error && <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {truncated && <p className="mb-4 text-sm text-amber-700">Showing the first 1,000 entries. Choose a site to see the rest.</p>}

      {/* Month grid (tablet and desktop) */}
      <div className="hidden overflow-hidden rounded-lg border md:block" data-testid="calendar-grid">
        <div className="grid grid-cols-7 border-b bg-muted/50 text-xs font-medium text-muted-foreground">
          {WEEKDAYS.map(day => <div key={day} className="px-2 py-1.5">{day}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {days.map(day => {
            const date = iso(day);
            const inMonth = day.getMonth() === month.month;
            const dayEntries = byDate.get(date) ?? [];
            const hidden = dayEntries.length - MAX_IN_CELL;
            return (
              <div
                key={date}
                className={cn(
                  "min-h-[7rem] min-w-0 border-b border-r p-1.5 [&:nth-child(7n)]:border-r-0",
                  !inMonth && "bg-muted/30 text-muted-foreground",
                  selected === date && "bg-primary/5",
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelected(selected === date ? null : date)}
                  aria-label={`${dayHeading(date)}: ${dayEntries.length} item${dayEntries.length === 1 ? "" : "s"}`}
                  className={cn(
                    "mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs",
                    date === today ? "bg-primary font-semibold text-primary-foreground" : "hover:bg-muted",
                  )}
                >
                  {day.getDate()}
                </button>
                <div className="space-y-1">
                  {dayEntries.slice(0, MAX_IN_CELL).map(entry => <EntryChip key={entry.id} entry={entry} compact />)}
                  {hidden > 0 && (
                    <button type="button" onClick={() => setSelected(date)} className="text-[11px] font-medium text-primary hover:underline">
                      +{hidden} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <section className="mt-4 hidden rounded-lg border p-4 md:block" aria-label={`Due on ${dayHeading(selected)}`}>
          <h3 className="mb-2 font-bold">{dayHeading(selected)}</h3>
          {(byDate.get(selected) ?? []).length === 0
            ? <p className="text-sm text-muted-foreground">Nothing due on this day.</p>
            : <div className="grid gap-2 lg:grid-cols-2">{(byDate.get(selected) ?? []).map(entry => <EntryChip key={entry.id} entry={entry} />)}</div>}
        </section>
      )}

      {/* List (phones) */}
      <div className="space-y-4 md:hidden" data-testid="calendar-list">
        {!loading && monthDates.length === 0 && (
          <div className="flex flex-col items-center rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
            <CalendarDays className="mb-2 h-8 w-8" />Nothing falls due in {monthLabel}.
          </div>
        )}
        {monthDates.map(date => (
          <section key={date}>
            <h3 className={cn("mb-1.5 text-sm font-semibold", date === today && "text-primary")}>
              {dayHeading(date)}{date === today && " · Today"}
            </h3>
            <div className="space-y-1.5">
              {(byDate.get(date) ?? []).map(entry => <EntryChip key={entry.id} entry={entry} />)}
            </div>
          </section>
        ))}
      </div>
    </AppLayout>
  );
}
