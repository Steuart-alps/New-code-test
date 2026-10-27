import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BusinessDashboard, BusinessDashboardChange } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { useAuth } from "@/context/auth-context";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw } from "lucide-react";

// Platform operators' view of the business: the figures of ALPS's Monday
// billing digest (new, cancelled, net, reasons, most used modules) for any
// dates. Days are UTC, like the API.

/** The day ComplyTrack opened to the public. */
const LAUNCH_DAY = "2026-10-26";

type Preset = "7" | "30" | "90" | "launch" | "custom";

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return isoDay(new Date(Date.now() - days * 86_400_000));
}

function rangeFor(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const today = isoDay(new Date());
  if (preset === "custom") return custom;
  if (preset === "launch") return { from: LAUNCH_DAY, to: today };
  return { from: daysAgo(Number(preset) - 1), to: today };
}

const money = (pence: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Math.abs(pence) / 100);
const signedMoney = (pence: number) => `${pence > 0 ? "+" : pence < 0 ? "−" : ""}${money(pence)}`;
const signedCount = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
const ukDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

function StatCard({ label, value, note, tone = "neutral" }: { label: string; value: string; note: string; tone?: "good" | "bad" | "neutral" }) {
  const colour = tone === "good" ? "text-green-600" : tone === "bad" ? "text-red-600" : "text-foreground";
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`text-3xl font-extrabold ${colour}`}>{value}</p>
      <p className="text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

function BarList({ rows, colour, empty }: { rows: Array<{ label: string; value: number; note?: string; colour?: string }>; colour: string; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div className="space-y-2">
      {rows.map(row => (
        <div key={row.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] sm:grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3">
          <span className="text-sm truncate" title={row.label}>{row.label}</span>
          <div className="h-4 rounded bg-muted overflow-hidden">
            {row.value > 0 && (
              <div className={`h-full rounded ${row.colour ?? colour}`} style={{ width: `${Math.max(3, Math.round((row.value / max) * 100))}%` }} />
            )}
          </div>
          <span className="text-sm font-bold tabular-nums whitespace-nowrap">
            {row.value}{row.note && <span className="font-normal text-muted-foreground"> {row.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="bg-card border border-border rounded-xl p-5 space-y-3">
      <div>
        <h2 className="font-bold text-base">{title}</h2>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function ChangeList({ rows, empty }: { rows: BusinessDashboardChange[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {[...rows].reverse().map((row, i) => (
        <li key={`${row.at}-${i}`} className="py-2 text-sm">
          <span className="font-semibold">{row.businessName}</span>
          <span className="text-muted-foreground"> · {ukDate(row.at)}</span>
          <p className="text-muted-foreground">{row.summary}</p>
        </li>
      ))}
    </ul>
  );
}

export default function BusinessDashboardPage() {
  const { user } = useAuth();
  const [preset, setPreset] = useState<Preset>("7");
  const [custom, setCustom] = useState({ from: daysAgo(29), to: isoDay(new Date()) });
  const range = rangeFor(preset, custom);
  const validRange = Boolean(range.from && range.to && range.from <= range.to);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<BusinessDashboard>({
    queryKey: ["business-dashboard", range.from, range.to],
    enabled: Boolean(user?.platformOperator) && validRange,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const res = await apiFetch(`/admin/business-dashboard?from=${range.from}&to=${range.to}`, { signal });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load the business dashboard."));
      return res.json();
    },
  });

  if (!user?.platformOperator) {
    return (
      <AppLayout title="Business dashboard">
        <p className="text-muted-foreground">Only ALPS platform administrators can see this page.</p>
      </AppLayout>
    );
  }

  const presets: Array<[Preset, string]> = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["launch", "Since launch"], ["custom", "Choose dates"]];

  return (
    <AppLayout title="Business dashboard">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end gap-2">
          {presets.map(([value, label]) => (
            <Button key={value} size="sm" variant={preset === value ? "default" : "outline"} onClick={() => setPreset(value)}>
              {label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching || !validRange} title="Refresh">
            <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="dashboard-from">From</Label>
              <Input id="dashboard-from" type="date" value={custom.from} max={custom.to} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dashboard-to">To</Label>
              <Input id="dashboard-to" type="date" value={custom.to} min={custom.from} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} />
            </div>
            {!validRange && <p className="text-sm text-red-600">The start date must be on or before the end date.</p>}
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {ukDate(`${range.from}T12:00:00Z`)} to {ukDate(`${range.to}T12:00:00Z`)}. Amounts are monthly, before VAT. The same figures go to ALPS in the Monday email.
        </p>

        {isError ? (
          <p className="text-red-600">{(error as Error).message}</p>
        ) : isLoading || !data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="New subscriptions" value={`+${data.newSubscriptions.length}`} note={`+${money(data.gainedPence)} a month`} tone="good" />
              <StatCard label="Cancellations" value={`−${data.cancellations.length}`} note={`−${money(data.lostPence)} a month`} tone={data.cancellations.length ? "bad" : "neutral"} />
              <StatCard
                label="Net gain or loss"
                value={signedCount(data.netBusinesses)}
                note={`${signedMoney(data.netPence)} a month, including plan changes (${signedMoney(data.planChangePence)})`}
                tone={data.netPence > 0 ? "good" : data.netPence < 0 ? "bad" : "neutral"}
              />
              <StatCard label="Now" value={String(data.totals.paying)} note={`paying, and ${data.totals.onTrial} on a free trial`} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="New and cancelled">
                <BarList
                  colour="bg-green-600"
                  empty=""
                  rows={[
                    { label: "New subscriptions", value: data.newSubscriptions.length },
                    { label: "Cancellations", value: data.cancellations.length, colour: "bg-red-600" },
                    { label: "New free trials", value: data.trials.length, colour: "bg-blue-600" },
                  ]}
                />
              </Section>
              <Section title="Why businesses cancelled" hint="The reason picked when cancelling, or why Stripe ended it.">
                <BarList colour="bg-amber-500" empty="No cancellations in these dates." rows={data.reasons.map(r => ({ label: r.label, value: r.count }))} />
              </Section>
              <Section title="Most used modules" hint="Records saved or updated, across all businesses.">
                <BarList
                  colour="bg-blue-600"
                  empty="No records were saved in these dates."
                  rows={data.modules.map(m => ({ label: m.module, value: m.changes, note: `in ${m.businesses} business${m.businesses === 1 ? "" : "es"}` }))}
                />
              </Section>
              {data.weeks.length > 1 && (
                <Section title="Week by week" hint="New and cancelled subscriptions each week (weeks start on Monday), and the net change a month.">
                  <div className="space-y-2">
                    {data.weeks.map(w => {
                      const max = Math.max(1, ...data.weeks.map(x => Math.max(x.newCount, x.cancelledCount)));
                      return (
                        <div key={w.weekStart} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3 text-sm">
                          <span className="text-muted-foreground">{ukDate(`${w.weekStart}T12:00:00Z`).replace(/ \d{4}$/, "")}</span>
                          <div className="space-y-1">
                            <div className="h-2.5 rounded bg-green-600" style={{ width: `${(w.newCount / max) * 100}%`, minWidth: w.newCount ? "4px" : 0 }} title={`${w.newCount} new`} />
                            <div className="h-2.5 rounded bg-red-600" style={{ width: `${(w.cancelledCount / max) * 100}%`, minWidth: w.cancelledCount ? "4px" : 0 }} title={`${w.cancelledCount} cancelled`} />
                          </div>
                          <span className="tabular-nums whitespace-nowrap">
                            +{w.newCount} / −{w.cancelledCount} · <span className={w.netPence < 0 ? "text-red-600" : w.netPence > 0 ? "text-green-600" : ""}>{signedMoney(w.netPence)}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={`New subscriptions (${data.newSubscriptions.length})`}>
                <ChangeList rows={data.newSubscriptions} empty="None in these dates." />
              </Section>
              <Section title={`Cancellations (${data.cancellations.length})`}>
                <ChangeList rows={data.cancellations} empty="None in these dates." />
              </Section>
              <Section title={`Plan changes (${data.planChanges.length})`} hint="Modules, AI, storage and sites added or removed.">
                <ChangeList rows={data.planChanges} empty="None in these dates." />
              </Section>
              <Section title={`New free trials (${data.trials.length})`}>
                {data.trials.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None in these dates.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {[...data.trials].reverse().map((t, i) => (
                      <li key={`${t.at}-${i}`} className="py-2 text-sm">
                        <span className="font-semibold">{t.businessName}</span>
                        <span className="text-muted-foreground"> · signed up {ukDate(t.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
