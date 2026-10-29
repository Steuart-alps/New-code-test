import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, ChevronDown, Users } from "lucide-react";
import {
  getGetTodayByDepartmentQueryKey,
  useGetTodayByDepartment,
  type TodayByDepartmentGroup,
  type TodayByDepartmentRow,
} from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";

function rowTotal(row: TodayByDepartmentRow) {
  return row.done + row.todo + row.failed;
}

function countLabel(row: TodayByDepartmentRow) {
  const total = rowTotal(row);
  if (total === 0) return "Nothing due or saved today";
  return `${row.done}/${total} done`;
}

/** One stacked bar: done, then failed, then not done yet, to scale. */
function Bar({ row }: { row: TodayByDepartmentRow }) {
  const total = rowTotal(row);
  const width = (count: number) => `${(count / total) * 100}%`;
  return (
    <span
      className="flex h-3.5 w-full gap-0.5 overflow-hidden rounded-sm bg-muted"
      role="img"
      aria-label={total === 0 ? "Nothing due or saved today" : `${row.done} done, ${row.failed} failed, ${row.todo} not done yet`}
    >
      {total > 0 && row.done > 0 && <i className="block h-full bg-emerald-500" style={{ width: width(row.done) }} />}
      {total > 0 && row.failed > 0 && <i className="block h-full bg-rose-500" style={{ width: width(row.failed) }} />}
      {total > 0 && row.todo > 0 && <i className="block h-full bg-amber-400" style={{ width: width(row.todo) }} />}
    </span>
  );
}

/** Where to go from a bar with nothing outstanding: today's checklists and tasks. */
function NothingOutstanding({ row, siteId }: { row: TodayByDepartmentRow; siteId: number | null }) {
  const { hasService } = useAuth();
  const hasAm = hasService("dailytrack_am") || hasService("kitchentrack") || hasService("premisestrack");
  const hasPm = hasService("dailytrack_pm") || hasService("kitchentrack") || hasService("premisestrack");
  const site = siteId != null ? `?siteId=${siteId}` : "";
  const links = [
    ...(hasAm ? [{ href: `/daily-track-am${site}`, label: "AM checklists" }] : []),
    ...(hasPm ? [{ href: `/daily-track-pm${site}`, label: "PM checklists" }] : []),
    { href: "/tasks", label: "Tasks" },
  ];
  return (
    <div className="space-y-1.5 border-t border-border/60 px-3 py-2 text-sm">
      <p className="text-muted-foreground">
        {rowTotal(row) === 0 ? "Nothing was due or saved here today." : "Everything due here today is done."}
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center gap-1 rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {link.label} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        ))}
      </p>
    </div>
  );
}

function DepartmentBar({ row, siteId, open, onToggle }: {
  row: TodayByDepartmentRow;
  siteId: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const outstanding = row.todo + row.failed;
  return (
    <li className="rounded-md border border-border/60 bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:grid-cols-[10rem_minmax(0,1fr)_10.5rem]"
      >
        <span className={cn("min-w-0 truncate text-sm font-medium", row.kind === "whole_site" && "text-muted-foreground")}>
          {row.name}
        </span>
        <span className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"><Bar row={row} /></span>
        <span className="col-start-2 row-start-1 flex items-center justify-end gap-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground sm:col-start-auto sm:row-start-auto">
          {countLabel(row)}
          {row.failed > 0 && <span className="font-medium text-rose-700">· {row.failed} failed</span>}
          <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {open && outstanding === 0 && <NothingOutstanding row={row} siteId={siteId} />}
      {open && outstanding > 0 && (
        <ul className="space-y-1.5 border-t border-border/60 px-3 py-2">
          {row.items.map((item, index) => (
            <li key={index}>
              <Link
                href={item.path}
                className="flex items-start justify-between gap-3 rounded-sm text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <span className="min-w-0">
                  <span className={cn(
                    "mr-1.5 inline-block rounded-full px-1.5 py-px text-[11px] font-medium",
                    item.status === "failed" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800",
                  )}>
                    {item.status === "failed" ? "Failed" : "Not done yet"}
                  </span>
                  {item.label}
                  {item.detail && <span className="block text-xs text-muted-foreground">{item.detail}</span>}
                </span>
                <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              </Link>
            </li>
          ))}
          {row.moreItems > 0 && <li className="text-xs text-muted-foreground">and {row.moreItems} more</li>}
        </ul>
      )}
    </li>
  );
}

function SiteGroup({ group, openKey, setOpenKey, showName }: {
  group: TodayByDepartmentGroup;
  openKey: string | null;
  setOpenKey: (key: string | null) => void;
  showName: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {showName && (
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.siteName}</p>
      )}
      <ul className="space-y-1.5">
        {group.rows.map((row) => {
          const key = `${group.siteId ?? "all"}:${row.key}`;
          return (
            <DepartmentBar
              key={key}
              row={row}
              siteId={group.siteId}
              open={openKey === key}
              onToggle={() => setOpenKey(openKey === key ? null : key)}
            />
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Dashboard card: today's checks for each department (and the whole site) as
 * done / not done yet / failed bars, grouped by site. Clicking a bar lists
 * what is outstanding with a link to each. The server decides who sees it
 * (Owners always; other roles as chosen in Settings) and which departments;
 * the card renders nothing when it is not shown for this person.
 */
export function TodayByDepartmentCard({ siteId = null }: { siteId?: number | null }) {
  const { activeClientId } = useAuth();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const params = siteId ? { siteId } : undefined;
  const { data, isLoading, error, refetch } = useGetTodayByDepartment(params, {
    // A 403 means the card is not shown for this role: don't retry it.
    query: { retry: false, queryKey: [...getGetTodayByDepartmentQueryKey(params), activeClientId] },
  });
  const status = (error as { status?: number } | null)?.status;
  if (status === 403) return null;
  if (isLoading) return <div className="h-28 rounded-lg bg-muted animate-pulse" />;

  const groups = data?.groups ?? [];
  const dateLabel = data
    ? new Date(`${data.date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    : "";

  return (
    <section aria-labelledby="today-by-department-heading" className="rounded-lg border border-border/60 bg-card px-4 py-3" data-testid="card-today-by-department">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <h2 id="today-by-department-heading" className="flex items-center gap-1.5 text-sm font-bold">
            <Users className="h-4 w-4 text-muted-foreground" /> Today by department
          </h2>
          {dateLabel && <p className="mt-0.5 text-xs text-muted-foreground">{dateLabel} · click a bar to see what's outstanding and open it</p>}
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-hidden="true">
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[2px] bg-emerald-500" />Done</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[2px] bg-amber-400" />Not done yet</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[2px] bg-rose-500" />Failed</span>
        </div>
      </div>

      {error ? (
        <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <span>We couldn't load today's department status.</span>
          <button type="button" className="rounded-sm border border-rose-300 bg-white px-3 py-1 font-medium hover:bg-rose-100" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      ) : groups.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing to show yet. Add departments in Settings, and today's checklists, tasks and checks will appear here.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map((group) => (
            <SiteGroup
              key={group.siteId ?? "all"}
              group={group}
              openKey={openKey}
              setOpenKey={setOpenKey}
              showName={groups.length > 1 || group.siteId === null}
            />
          ))}
        </div>
      )}
    </section>
  );
}
