import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Timer, Users, UserX } from "lucide-react";
import { useGetFireDrillAttendance, type FireDrillAttendee } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCanAdmin } from "@/context/auth-context";
import { format } from "date-fns";

// ── Time of drill and time taken to evacuate ─────────────────────────────────

export type EvacuationValue = { minutes: string; seconds: string };

export const EMPTY_EVACUATION: EvacuationValue = { minutes: "", seconds: "" };

export function evacuationFromSeconds(total: number | null | undefined): EvacuationValue {
  if (total == null) return EMPTY_EVACUATION;
  return { minutes: String(Math.floor(total / 60)), seconds: String(total % 60) };
}

/** Whole seconds, or null when blank or not a valid time (0-59 seconds, at least 1 second in all). */
export function parseEvacuation(value: EvacuationValue): number | null {
  const minutesText = value.minutes.trim();
  const secondsText = value.seconds.trim();
  if (!minutesText && !secondsText) return null;
  if (!/^\d*$/.test(minutesText) || !/^\d*$/.test(secondsText)) return null;
  const minutes = Number(minutesText || 0);
  const seconds = Number(secondsText || 0);
  if (seconds > 59 || minutes > 1440) return null;
  const total = minutes * 60 + seconds;
  return total >= 1 ? total : null;
}

export function evacuationIsBlank(value: EvacuationValue): boolean {
  return !value.minutes.trim() && !value.seconds.trim();
}

/** "2 min 35 s", "45 s", "3 min". */
export function formatEvacuation(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

export function DrillTimingFields({ drillTime, onDrillTimeChange, evacuation, onEvacuationChange, optional }: {
  drillTime: string;
  onDrillTimeChange: (value: string) => void;
  evacuation: EvacuationValue;
  onEvacuationChange: (value: EvacuationValue) => void;
  /** Older drills saved before these fields existed may stay blank. */
  optional?: boolean;
}) {
  const invalid = !evacuationIsBlank(evacuation) && parseEvacuation(evacuation) === null;
  const optionalTag = optional ? <span className="text-muted-foreground text-xs font-normal">optional</span> : null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="drill-time">Time of drill {optionalTag}</Label>
        <Input id="drill-time" type="time" value={drillTime} onChange={e => onDrillTimeChange(e.target.value)}
          className="rounded-sm" data-testid="input-drill-time" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="evacuation-minutes" className="flex items-center gap-1.5">
          <Timer className="w-3.5 h-3.5 text-primary" />Time taken to evacuate {optionalTag}
        </Label>
        <div className="flex items-center gap-2">
          <Input id="evacuation-minutes" inputMode="numeric" value={evacuation.minutes} aria-label="Minutes"
            onChange={e => onEvacuationChange({ ...evacuation, minutes: e.target.value })}
            className="rounded-sm w-20" placeholder="0" data-testid="input-evacuation-minutes" />
          <span className="text-xs text-muted-foreground">min</span>
          <Input inputMode="numeric" value={evacuation.seconds} aria-label="Seconds"
            onChange={e => onEvacuationChange({ ...evacuation, seconds: e.target.value })}
            className="rounded-sm w-20" placeholder="0" data-testid="input-evacuation-seconds" />
          <span className="text-xs text-muted-foreground">sec</span>
        </div>
        {invalid && <p className="text-xs text-rose-700">Enter minutes, and seconds from 0 to 59.</p>}
      </div>
    </div>
  );
}

// ── Staff present ────────────────────────────────────────────────────────────

type RosterMember = { id: number; name: string; site_id: number | null; site_name?: string | null; active?: boolean };

function useActiveRoster() {
  return useQuery({
    queryKey: ["staff-roster", "fire-drill"],
    queryFn: async (): Promise<RosterMember[]> => {
      const response = await apiFetch("/staff-roster");
      if (!response.ok) return [];
      const rows = await response.json();
      return (Array.isArray(rows) ? rows : []).filter((member: RosterMember) => member.active !== false);
    },
    staleTime: 60_000,
  });
}

/**
 * Tick the roster staff present at a drill. With a site chosen, the list is
 * that site's staff and staff with no site. Anyone already on the record stays
 * listed, even if they have since left the roster or moved site.
 */
export function DrillStaffPicker({ siteId, value, onChange, recorded = [] }: {
  siteId: number | undefined;
  value: number[];
  onChange: (value: number[]) => void;
  recorded?: FireDrillAttendee[];
}) {
  const { data: roster = [], isLoading } = useActiveRoster();
  const canAdmin = useCanAdmin();
  const people = useMemo(() => {
    const listed = new Map<number, { id: number; name: string; siteName: string | null }>();
    for (const member of roster) {
      if (siteId !== undefined && member.site_id != null && member.site_id !== siteId) continue;
      listed.set(member.id, { id: member.id, name: member.name, siteName: member.site_name ?? null });
    }
    for (const person of recorded) {
      if (person.staffRosterId != null && !listed.has(person.staffRosterId)) {
        listed.set(person.staffRosterId, { id: person.staffRosterId, name: person.name, siteName: null });
      }
    }
    return Array.from(listed.values()).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  }, [roster, recorded, siteId]);
  // People removed from the roster altogether are kept on the record as they were.
  const removed = recorded.filter(person => person.staffRosterId == null);
  const ticked = new Set(value);
  const showSites = siteId === undefined && people.some(person => person.siteName);
  const toggle = (id: number, on: boolean) => onChange(on ? [...value, id] : value.filter(other => other !== id));

  return (
    <div className="space-y-2 border border-border rounded-sm p-3 bg-muted/20" data-testid="drill-staff-picker">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium flex items-center gap-2">
          <Users className="w-4 h-4 text-primary flex-shrink-0" />Staff present
          <span className="text-xs text-muted-foreground font-normal">{ticked.size} of {people.length} ticked</span>
        </p>
        {people.length > 0 && (
          <div className="flex gap-3 text-xs">
            <button type="button" className="text-primary hover:underline" onClick={() => onChange(people.map(p => p.id))}>Tick all</button>
            <button type="button" className="text-primary hover:underline" onClick={() => onChange([])}>Clear</button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Tick everyone who took part. TrainTrack shows who has not been in a drill in the last 12 months.</p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading the staff roster…</p>
      ) : people.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No one is on the staff roster{siteId !== undefined ? " for this site" : ""} yet.{" "}
          {canAdmin
            ? <>Add staff in <Link href="/staff-roster" className="text-primary underline">Staff Roster</Link> to tick who took part.</>
            : "A manager can add staff to the roster so you can tick who took part."}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 max-h-56 overflow-y-auto pr-1">
          {people.map(person => (
            <label key={person.id} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={ticked.has(person.id)} onCheckedChange={on => toggle(person.id, on === true)}
                data-testid={`drill-staff-${person.id}`} />
              <span>{person.name}{showSites && person.siteName ? <span className="text-xs text-muted-foreground"> · {person.siteName}</span> : null}</span>
            </label>
          ))}
        </div>
      )}
      {removed.length > 0 && (
        <p className="text-xs text-muted-foreground">Also present (no longer on the roster): {removed.map(p => p.name).join(", ")}</p>
      )}
    </div>
  );
}

// ── Staff not in a drill recently ─────────────────────────────────────────────

/**
 * Roster staff who have not been ticked present at a fire drill in the last
 * 12 months, for FireTrack and TrainTrack. Hidden until the roster has staff.
 */
export function DrillAttendanceCard({ siteId, trackLink }: { siteId?: number; trackLink?: boolean }) {
  const { data } = useGetFireDrillAttendance(siteId !== undefined ? { siteId } : undefined);
  // Hidden until the roster has staff (or if the answer is not the expected shape).
  const staff = Array.isArray(data?.staff) ? data.staff : [];
  if (!data || staff.length === 0) return null;
  const due = staff.filter(person => person.due);
  return (
    <Card className="rounded-sm" data-testid="drill-attendance-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <UserX className="w-4 h-4 text-primary" />Staff fire drills
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {due.length === 0 ? (
          <p className="text-emerald-700">All {staff.length} staff have taken part in a fire drill in the last {data.periodMonths} months.</p>
        ) : (
          <>
            <p className="text-amber-800">
              {due.length} of {staff.length} staff {due.length === 1 ? "has" : "have"} not taken part in a fire drill in the last {data.periodMonths} months.
            </p>
            <ul className="text-xs grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              {due.map(person => (
                <li key={person.staffRosterId} className="flex justify-between gap-2 border-b border-border/50 py-1">
                  <span>{person.name}{person.siteName ? <span className="text-muted-foreground"> · {person.siteName}</span> : null}</span>
                  <span className="text-muted-foreground whitespace-nowrap">
                    {person.lastDrillDate ? `Last: ${format(new Date(person.lastDrillDate), "dd/MM/yyyy")}` : "Never"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {trackLink && (
          <p className="text-xs text-muted-foreground">
            Drills and who took part are recorded in <Link href="/fire-safety" className="text-primary underline">FireTrack</Link>.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
