import { useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, ClipboardCheck, ListChecks, Thermometer, Wheat } from "lucide-react";
import { useGetFoodSafetyMonthSummary, getGetFoodSafetyMonthSummaryQueryKey, type KitchenMonthSummarySite } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRegisterList } from "@/components/register-shared";
import { useAuth } from "@/context/auth-context";
import { CHARTS_PATH, type AllergenChart } from "@/lib/allergens";
import { cn } from "@/lib/utils";

/** The month as YYYY-MM, moved by a number of months. */
export function shiftMonth(month: string, by: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const moved = new Date(Date.UTC(year, monthNumber - 1 + by, 1));
  return moved.toISOString().slice(0, 7);
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const dayLabel = (date: string) => format(new Date(`${date}T00:00:00`), "d MMM");
const monthLabel = (month: string) => format(new Date(`${month}-01T00:00:00`), "MMMM yyyy");

type Tone = "good" | "warn" | "bad" | "plain";
const TONES: Record<Tone, string> = {
  good: "border-l-emerald-500 bg-emerald-50/50",
  warn: "border-l-amber-500 bg-amber-50/50",
  bad: "border-l-rose-500 bg-rose-50/50",
  plain: "border-l-slate-300 bg-slate-50/50",
};

function Tile({ icon: Icon, title, value, detail, tone, onClick, href, label }: {
  icon: typeof CalendarDays; title: string; value: string; detail: string; tone: Tone;
  onClick?: () => void; href?: string; label: string;
}) {
  const body = (
    <div className={cn("h-full rounded-md border border-l-4 px-3 py-2.5 text-left transition-all hover:shadow-md", TONES[tone])}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Icon className="h-3.5 w-3.5" />{title}</p>
      <p className="mt-1 text-lg font-semibold leading-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
  if (href) return <Link href={href} aria-label={label} className="block">{body}</Link>;
  return <button type="button" onClick={onClick} aria-label={label} className="block w-full">{body}</button>;
}

/** "This month" for Owners and Managers: diary days kept and missed, failed
 *  readings, KitchenTrack actions and allergen charts waiting to be signed off. */
export function KitchenMonthSummary({ onOpenDay }: { onOpenDay: (date: string, siteId: number | null) => void }) {
  const { user, activeClientId } = useAuth();
  const allowed = user?.role === "consultant" || user?.role === "client_admin" || user?.role === "client_manager";
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const { data: summary, isError } = useGetFoodSafetyMonthSummary(params, {
    query: { enabled: allowed, queryKey: [...getGetFoodSafetyMonthSummaryQueryKey(params), activeClientId] },
  });
  const { data: charts = [] } = useRegisterList<AllergenChart>(CHARTS_PATH, allowed);

  if (!allowed || isError || !summary) return null;

  const shown = summary.month;
  const thisMonth = summary.today.slice(0, 7);
  const totals = summary.totals;
  const operating = totals.daysCounted - totals.closedDays;
  const toCheck = charts.filter((chart) => chart.dishCount > 0 && (!chart.lastSignoff || chart.changedSinceCheck));
  const neverChecked = toCheck.filter((chart) => !chart.lastSignoff).length;
  const multiSite = summary.sites.length > 1;
  const notStarted = summary.sites.every((site) => !site.startedOn);
  const isCurrent = shown === thisMonth;
  // Open actions and charts to sign off are as they stand today, whichever month is shown.
  const now = isCurrent ? "" : " now";

  const scrollToActions = () => document.getElementById("module-actions-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const diaryDetail = summary.through === null
    ? "Nothing to count yet: today's diary is still open"
    : notStarted ? "No diary records yet"
      : [
        totals.missedDays ? `${totals.missedDays} missed` : "none missed",
        totals.draftDays ? `${totals.draftDays} not submitted` : null,
        totals.closedDays ? `${totals.closedDays} closed` : null,
      ].filter(Boolean).join(" · ");

  return (
    <Card aria-labelledby="kitchen-month-heading">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <div>
          <CardTitle id="kitchen-month-heading" className="text-base">{isCurrent ? "This month" : monthLabel(shown)}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {summary.through ? `Diary counted up to ${dayLabel(summary.through)}${isCurrent ? " (today is still open)" : ""}.` : `${monthLabel(shown)}.`}
            {" "}For Owners and Managers.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Previous month" onClick={() => setMonth(shiftMonth(shown, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[7.5rem] text-center text-sm font-medium" aria-live="polite">{monthLabel(shown)}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Next month" disabled={shown >= thisMonth} onClick={() => setMonth(shiftMonth(shown, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            icon={CalendarDays} title="Daily diary"
            value={summary.through === null || notStarted ? "–" : `${totals.recordedDays} of ${operating} days`}
            detail={diaryDetail}
            tone={summary.through === null || notStarted ? "plain" : totals.missedDays ? "bad" : totals.draftDays ? "warn" : "good"}
            href="/food-safety" label="Daily diary days: open the diary calendar"
          />
          <Tile
            icon={Thermometer} title="Failed readings"
            value={String(totals.failedReadings)}
            detail={totals.failedReadings ? "Each one raised an action" : "No failed temperatures"}
            tone={totals.failedReadings ? "warn" : "good"}
            onClick={scrollToActions} label="Failed readings: go to KitchenTrack actions"
          />
          <Tile
            icon={ListChecks} title="Actions"
            value={`${totals.actionsOpen} open${now}`}
            detail={[
              `${totals.actionsRaised} raised ${isCurrent ? "this month" : `in ${format(new Date(`${shown}-01T00:00:00`), "MMMM")}`}, ${totals.actionsResolved} closed`,
              totals.actionsOverdue ? `${totals.actionsOverdue} overdue` : null,
            ].filter(Boolean).join(" · ")}
            tone={totals.actionsOverdue ? "bad" : totals.actionsOpen ? "warn" : "good"}
            onClick={scrollToActions} label="Actions: go to KitchenTrack actions"
          />
          <Tile
            icon={Wheat} title={`Allergen charts${now}`}
            value={charts.length === 0 ? "None yet" : toCheck.length ? `${toCheck.length} to sign off` : "All signed off"}
            detail={charts.length === 0
              ? "Add dishes in Allergen records"
              : toCheck.length ? [neverChecked ? `${neverChecked} never checked` : null, toCheck.length - neverChecked ? `${toCheck.length - neverChecked} changed since checked` : null].filter(Boolean).join(" · ") : "No changes since the last check"}
            tone={charts.length === 0 ? "plain" : toCheck.length ? "warn" : "good"}
            href="/allergens?tab=charts" label="Allergen charts: open the charts"
          />
        </div>

        {multiSite && (
          <ul className="divide-y rounded-md border sm:hidden" aria-label="Sites">
            {summary.sites.map((site) => (
              <li key={site.siteId ?? "all"} className="space-y-1.5 px-3 py-2.5 text-sm">
                <p className="font-medium">{site.siteName ?? "Whole business"}</p>
                <p className="text-xs text-muted-foreground">
                  Diary {siteDiary(site)} · {plural(site.failedReadings, "failed reading")} · <span className={cn(site.actionsOpen > 0 && "font-semibold text-amber-700")}>{plural(site.actionsOpen, "open action")}</span>
                </p>
                {site.missedDates.length > 0 && <MissedDays site={site} onOpenDay={onOpenDay} />}
              </li>
            ))}
          </ul>
        )}
        {multiSite && (
          <div className="hidden overflow-x-auto rounded-md border sm:block">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Site</th>
                  <th className="px-3 py-2 text-left font-medium">Diary</th>
                  <th className="px-3 py-2 text-left font-medium">Days missed</th>
                  <th className="px-3 py-2 text-right font-medium">Failed readings</th>
                  <th className="px-3 py-2 text-right font-medium">Open actions</th>
                </tr>
              </thead>
              <tbody>
                {summary.sites.map((site) => <SiteRow key={site.siteId ?? "all"} site={site} onOpenDay={onOpenDay} />)}
              </tbody>
            </table>
          </div>
        )}
        {!multiSite && summary.sites[0] && summary.sites[0].missedDates.length > 0 && (
          <MissedDays site={summary.sites[0]} onOpenDay={onOpenDay} />
        )}
        {totals.missedDays > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />
            A missed day has no diary at all. If the kitchen was shut, mark it closed on the diary calendar so it stops counting.
          </p>
        )}
        {totals.actionsOpen > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ClipboardCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Open actions are listed under KitchenTrack actions at the bottom of this page.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function MissedDays({ site, onOpenDay }: { site: KitchenMonthSummarySite; onOpenDay: (date: string, siteId: number | null) => void }) {
  if (site.missedDates.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">Missed:</span>
      {site.missedDates.map((date) => (
        <button
          key={date} type="button"
          onClick={() => onOpenDay(date, site.siteId)}
          aria-label={`Open the diary for ${dayLabel(date)}${site.siteName ? ` at ${site.siteName}` : ""}`}
          className="rounded-sm border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-100"
        >
          {dayLabel(date)}
        </button>
      ))}
    </div>
  );
}

function siteDiary(site: KitchenMonthSummarySite) {
  if (!site.startedOn) return "not started";
  return `${site.recordedDays} of ${site.daysCounted - site.closedDays}${site.draftDays ? ` · ${site.draftDays} not submitted` : ""}`;
}

function SiteRow({ site, onOpenDay }: { site: KitchenMonthSummarySite; onOpenDay: (date: string, siteId: number | null) => void }) {
  return (
    <tr className="border-t align-top">
      <td className="px-3 py-2 font-medium">{site.siteName ?? "Whole business"}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        {site.startedOn ? siteDiary(site) : <span className="text-muted-foreground">No diary yet</span>}
      </td>
      <td className="px-3 py-2"><MissedDays site={site} onOpenDay={onOpenDay} /></td>
      <td className="px-3 py-2 text-right">{site.failedReadings}</td>
      <td className={cn("px-3 py-2 text-right", site.actionsOpen > 0 && "font-semibold text-amber-700")}>{site.actionsOpen}</td>
    </tr>
  );
}
