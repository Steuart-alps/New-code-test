import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { formatDay, localToday } from "@/lib/onboarding";
import { useSiteFilter } from "@/hooks/use-working-site";
import { tradeLabel } from "@/lib/contractor-trades";

interface VisitType {
  key: string;
  trackLabel: string;
  label: string;
  description: string;
  dueFrom: "track" | "later" | "check";
  trades?: string[];
}

interface Visit {
  visitKey: string;
  siteId: number;
  siteName: string;
  trackDueDate: string | null;
  checkId: number | null;
  dueDate: string | null;
  status: string | null;
  contractorId: number | null;
  contractorName: string | null;
  reminderSentAt: string | null;
  notNeeded?: boolean;
}

/** A check from the compliance check register (gas safety, EICR...). */
interface RegisterCheck {
  checkId: number;
  title: string;
  siteId: number | null;
  siteName: string | null;
  dueDate: string | null;
  status: string;
  contractorId: number | null;
  contractorName: string | null;
  reminderSentAt: string | null;
  notNeeded: boolean;
}

interface Contractor { id: number; name: string; company?: string | null; trades?: string[] | null }

/** Select values besides a contractor id. */
const UNDECIDED = "none";
const ALL_SITES = "all";
const REGISTER_GROUP = "Compliance checks";

interface Row {
  id: string;
  /** The track visit's key, for links from a track ("Set it up"). */
  visitKey?: string;
  label: string;
  siteId: number | null;
  siteName: string | null;
  due: string | null;
  completed: boolean;
  noDateText: string;
  reminderSentAt: string | null;
  contractorId: number | null;
  contractorName: string | null;
  notNeeded: boolean;
  /** Contractor trades listed first in the contractor choice. */
  trades?: string[];
  /** Shown when the row takes a typed due date. */
  dateInput?: { value: string | null; onSave: (value: string | null) => void };
  choose: (choice: { contractorId: number | null; notNeeded: boolean }) => void;
}

/**
 * Every inspection the business's tracks keep that may need a contractor
 * (pest control, water servicing, fire servicing, GreenTrack's PUWER, LOLER
 * and NSTS lines and others), plus the compliance check register (gas
 * safety, EICR...). Each takes a contractor, who gets the reminder email
 * before it is due, or is marked "No contractor needed"; those fold away so
 * each track shows what needs a contractor.
 */
export function ContractorVisitsCard({ contractors }: { contractors: Contractor[] }) {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const clientApiFetch = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [siteFilter, setSiteFilter] = useSiteFilter(ALL_SITES);
  // A track's "Set it up" link opens /contractors?visit=<key>[&site=<id>]
  // and lands on that line.
  const [target] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return { visit: params.get("visit"), site: params.get("site") };
  });
  const [highlight, setHighlight] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<{ types: VisitType[]; visits: Visit[]; checks?: RegisterCheck[] }>({
    queryKey: ["contractor-visits", activeClientId],
    queryFn: async () => {
      const response = await clientApiFetch("/contractor-visits");
      if (!response.ok) throw new Error("Failed to load contractor visits");
      return response.json();
    },
    enabled: !!activeClientId,
  });

  const save = useMutation({
    mutationFn: async ({ path, body }: { path: string; body: Record<string, unknown> }) => {
      const response = await clientApiFetch(path, { method: "PUT", body: JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Could not save");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contractor-visits", activeClientId] });
      queryClient.invalidateQueries({ queryKey: ["compliance-items"] });
    },
    onError: (err: Error) => toast({ title: "Could not save", description: err.message, variant: "destructive" }),
  });

  const sites = useMemo(() => {
    const byId = new Map<number, string>();
    for (const visit of data?.visits ?? []) byId.set(visit.siteId, visit.siteName);
    for (const check of data?.checks ?? []) if (check.siteId != null && check.siteName) byId.set(check.siteId, check.siteName);
    return [...byId].map(([id, name]) => ({ id, name }));
  }, [data]);

  useEffect(() => {
    // Arriving from a track link: show that line's site.
    if (target.site) setSiteFilter(target.site);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => {
    if (!data || !target.visit) return;
    const candidates = [...document.querySelectorAll<HTMLElement>("[data-visit-key]")]
      .filter(element => element.dataset.visitKey === target.visit);
    const element = candidates.find(candidate => candidate.dataset.siteId === target.site) ?? candidates[0];
    if (!element) return;
    setHighlight(element.dataset.rowId ?? null);
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [data, target]);

  const checks = data?.checks ?? [];
  if (isLoading || !data || (data.types.length === 0 && checks.length === 0)) {
    return isError ? <p role="alert" className="text-destructive text-sm mb-8">Could not load contractor visits.</p> : null;
  }

  const typeByKey = new Map(data.types.map(type => [type.key, type]));
  const atSite = (siteId: number | null) => siteFilter === ALL_SITES || siteId == null || String(siteId) === siteFilter;
  const putVisit = (visit: Visit, body: Record<string, unknown>) =>
    save.mutate({ path: "/contractor-visits", body: { visitKey: visit.visitKey, siteId: visit.siteId, ...body } });

  const groups = new Map<string, Row[]>();
  const add = (group: string, row: Row) => groups.set(group, [...(groups.get(group) ?? []), row]);
  for (const type of data.types) groups.set(type.trackLabel, groups.get(type.trackLabel) ?? []);
  for (const visit of data.visits) {
    const type = typeByKey.get(visit.visitKey);
    if (!type || !atSite(visit.siteId)) continue;
    const takesDate = type.dueFrom === "check" || !visit.trackDueDate;
    add(type.trackLabel, {
      id: `${visit.visitKey}@${visit.siteId}`,
      visitKey: visit.visitKey,
      label: type.label,
      siteId: visit.siteId,
      siteName: visit.siteName,
      due: visit.dueDate ?? visit.trackDueDate,
      completed: visit.status === "completed",
      noDateText: type.dueFrom === "check" ? "Set the date it is due" : "No date yet: set one, or record the last visit on the track",
      reminderSentAt: visit.reminderSentAt,
      contractorId: visit.contractorId,
      contractorName: visit.contractorName,
      notNeeded: !!visit.notNeeded,
      trades: type.trades,
      dateInput: takesDate ? {
        value: visit.dueDate,
        onSave: value => putVisit(visit, { contractorId: visit.contractorId, dueDate: value }),
      } : undefined,
      choose: choice => putVisit(visit, choice),
    });
  }
  for (const check of checks) {
    if (!atSite(check.siteId)) continue;
    add(REGISTER_GROUP, {
      id: `check:${check.checkId}`,
      label: check.title,
      siteId: check.siteId,
      siteName: check.siteName ?? "All sites",
      due: check.dueDate,
      completed: check.status === "completed",
      noDateText: "No due date set on the check",
      reminderSentAt: check.reminderSentAt,
      contractorId: check.contractorId,
      contractorName: check.contractorName,
      notNeeded: check.notNeeded,
      choose: choice => save.mutate({ path: `/contractor-visits/checks/${check.checkId}`, body: choice }),
    });
  }

  const today = localToday();
  const showSite = sites.length > 1 && siteFilter === ALL_SITES;
  const allRows = [...groups.values()].flat();
  const undecided = allRows.filter(row => row.contractorId == null && !row.notNeeded).length;

  // Contractors with one of the row's trades come first.
  const contractorChoices = (trades: string[] | undefined) => {
    const item = (contractor: Contractor) => (
      <SelectItem key={contractor.id} value={String(contractor.id)}>
        {[contractor.name, contractor.company].filter(Boolean).join(", ")}
      </SelectItem>
    );
    const matches = (contractor: Contractor) =>
      !!trades?.length && !!contractor.trades?.some(trade => trades.includes(trade));
    const suggested = contractors.filter(matches);
    const others = contractors.filter(contractor => !matches(contractor));
    if (!suggested.length) return contractors.map(item);
    return (
      <>
        <SelectGroup>
          <SelectLabel>{trades!.map(tradeLabel).join(" or ")}</SelectLabel>
          {suggested.map(item)}
        </SelectGroup>
        {others.length > 0 && (
          <SelectGroup>
            <SelectLabel>Other contractors</SelectLabel>
            {others.map(item)}
          </SelectGroup>
        )}
      </>
    );
  };

  const renderRow = (row: Row) => {
    const overdue = !!row.due && row.due < today && !row.completed;
    const label = `${row.label}${showSite && row.siteName ? ` at ${row.siteName}` : ""}`;
    const value = row.contractorId != null ? String(row.contractorId) : UNDECIDED;
    let chosen: ReactNode;
    if (row.notNeeded) chosen = "No contractor needed";
    else if (row.contractorName) chosen = row.contractorName;
    else chosen = <span className="text-amber-700 dark:text-amber-400">Not chosen yet</span>;
    return (
      <li
        key={row.id}
        data-row-id={row.id}
        data-visit-key={row.visitKey}
        data-site-id={row.siteId ?? undefined}
        className={`flex flex-col md:flex-row md:items-center gap-2 md:gap-4 p-3${highlight === row.id ? " bg-primary/10 ring-2 ring-primary/40" : ""}`}
      >
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm">{row.label}</p>
          <p className="text-xs text-muted-foreground">
            {showSite && row.siteName && <>{row.siteName} · </>}
            {row.notNeeded
              ? "No contractor needed"
              : row.due
                ? <span className={overdue ? "text-rose-700 font-semibold" : undefined}>{overdue ? "Overdue since" : "Next due"} {formatDay(row.due)}</span>
                : row.noDateText}
            {!row.notNeeded && row.reminderSentAt && <> · Reminder sent</>}
          </p>
        </div>
        {row.notNeeded ? (
          canAdmin && (
            <Button
              type="button" variant="outline" size="sm"
              aria-label={`Add back: ${label}`}
              disabled={save.isPending}
              onClick={() => row.choose({ contractorId: null, notNeeded: false })}
            >
              Add back
            </Button>
          )
        ) : canAdmin ? (
          <>
            {row.dateInput && (
              <Input
                type="date"
                aria-label={`Due date: ${label}`}
                className="w-full md:w-40"
                defaultValue={row.dateInput.value ?? ""}
                onBlur={event => {
                  const next = event.target.value || null;
                  if (next !== row.dateInput!.value) row.dateInput!.onSave(next);
                }}
              />
            )}
            <div className="flex gap-2 w-full md:w-auto">
              <Select
                value={value}
                onValueChange={next => row.choose({ contractorId: next === UNDECIDED ? null : Number(next), notNeeded: false })}
                disabled={save.isPending}
              >
                <SelectTrigger
                  className={`flex-1 md:w-64${value === UNDECIDED ? " border-amber-500/70" : ""}`}
                  aria-label={`Contractor: ${label}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNDECIDED}>Not chosen yet</SelectItem>
                  {contractorChoices(row.trades)}
                </SelectContent>
              </Select>
              <Button
                type="button" variant="outline" size="sm" className="h-10 shrink-0"
                title="No contractor needed: hide this line (you can add it back)"
                aria-label={`No contractor needed: ${label}`}
                disabled={save.isPending}
                onClick={() => row.choose({ contractorId: null, notNeeded: true })}
              >
                N/A
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm md:w-64">{chosen}</p>
        )}
      </li>
    );
  };

  return (
    <Card className="p-5 mb-8 bg-card/60 border-border/50">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-display font-bold text-lg flex items-center gap-2">
            <CalendarClock aria-hidden="true" className="w-5 h-5 text-primary" /> Contractor inspections and visits
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Every inspection your tracks and compliance checks keep, with when each is next due. Choose who does each one, or
            press N/A if no contractor is needed (you do it yourselves, or it does not apply): the line is hidden until you add it
            back. The contractor gets one reminder email
            before it is due (your lead time), which waits in Contractor Approvals for a manager to send.
          </p>
          {undecided > 0 && (
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400 mt-2">
              {undecided} still to decide: choose a contractor or press N/A
            </p>
          )}
        </div>
        {sites.length > 1 && (
          <Select value={siteFilter} onValueChange={setSiteFilter}>
            <SelectTrigger className="w-full sm:w-52" aria-label="Site">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SITES}>All sites</SelectItem>
              {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-5">
        {[...groups].map(([group, rows]) => {
          if (!rows.length) return null;
          const needed = rows.filter(row => !row.notNeeded);
          const notNeeded = rows.filter(row => row.notNeeded);
          return (
            <section key={group} aria-label={group}>
              <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wide mb-2">{group}</h3>
              {needed.length > 0 ? (
                <ul className="divide-y divide-border/60 rounded-sm border border-border/60">{needed.map(renderRow)}</ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing here needs a contractor.</p>
              )}
              {notNeeded.length > 0 && (
                <details className="mt-2" open={notNeeded.some(row => row.id === highlight) || undefined}>
                  <summary className="text-xs text-muted-foreground cursor-pointer select-none">
                    Hidden, no contractor needed ({notNeeded.length}): show to add back
                  </summary>
                  <ul className="mt-2 divide-y divide-border/60 rounded-sm border border-border/60 opacity-80">{notNeeded.map(renderRow)}</ul>
                </details>
              )}
            </section>
          );
        })}
      </div>
    </Card>
  );
}
