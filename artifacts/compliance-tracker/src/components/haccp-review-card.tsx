import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CalendarCheck } from "lucide-react";
import { useListComplianceItems, type ComplianceItem } from "@workspace/api-client-react";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useAppMutations } from "@/hooks/use-app-data";
import { apiFetch } from "@/lib/api";
import { formatDay, localToday } from "@/lib/onboarding";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CompleteCheckDialog } from "@/components/complete-check-dialog";

const REVIEW_MONTHS = 12;
const DUE_SOON_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Any compliance check about reviewing the HACCP system, whoever named it. */
export function isHaccpReview(item: Pick<ComplianceItem, "title">): boolean {
  return /\bhaccp\b/i.test(item.title) && /\breview/i.test(item.title);
}

function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d!, lastDay));
  return first.toISOString().slice(0, 10);
}

function dueBadge(item: ComplianceItem) {
  if (!item.dueDate) return <Badge variant="outline">No due date</Badge>;
  const days = Math.round((new Date(item.dueDate).getTime() - Date.now()) / DAY_MS);
  if (days < 0) return <Badge variant="destructive">Overdue since {formatDay(item.dueDate)}</Badge>;
  const label = `Next due ${formatDay(item.dueDate)}`;
  return days <= DUE_SOON_DAYS
    ? <Badge className="border-amber-300 bg-amber-50 text-amber-900" variant="outline">{label}</Badge>
    : <Badge className="border-emerald-300 bg-emerald-50 text-emerald-800" variant="outline">{label}</Badge>;
}

/**
 * KitchenTrack's yearly HACCP system review. It is a repeating compliance
 * check, so it is reminded about, counted on the dashboard and kept in the
 * check's history like any other; this card shows it where kitchens look and
 * sets it up when the business has none.
 */
export function HaccpReviewCard() {
  const { user } = useAuth();
  const canAdmin = useCanAdmin();
  const canRecord = user?.role !== "client_viewer";
  const { data: items = [], isLoading } = useListComplianceItems({});
  const { createItem } = useAppMutations();
  const reviews = items.filter(isHaccpReview);
  const [recording, setRecording] = useState<ComplianceItem | null>(null);
  const [lastReviewed, setLastReviewed] = useState("");
  // Compliance Hub used to hold a "reviewed for this operation" flag with no
  // date; say so when setting up, so that answer is not lost.
  const [hubSaidReviewed, setHubSaidReviewed] = useState(false);
  const today = localToday();

  useEffect(() => {
    if (!canAdmin || isLoading || reviews.length > 0) return;
    let cancelled = false;
    apiFetch("/compliance-hub/profile")
      .then((response) => response.ok ? response.json() : null)
      .then((profile) => { if (!cancelled) setHubSaidReviewed(profile?.haccpSystemReviewed === true); })
      .catch(() => { /* only a hint */ });
    return () => { cancelled = true; };
  }, [canAdmin, isLoading, reviews.length]);

  if (isLoading) return null;
  const invalidDate = lastReviewed && (lastReviewed > today || lastReviewed < "2000-01-01");

  async function setUp() {
    if (invalidDate) return;
    const due = lastReviewed ? addMonths(lastReviewed, REVIEW_MONTHS) : today;
    try {
      await createItem.mutateAsync({
        data: {
          title: "HACCP System Review",
          description: "Review the HACCP plan (or CookSafe / Safer Food Better Business pack) against the menu, suppliers, equipment and processes in use, and update it. Review at least once a year and whenever something changes.",
          priority: "high",
          frequencyMonths: REVIEW_MONTHS,
          dueDate: new Date(`${due}T00:00:00Z`).toISOString(),
          leadTimeDays: 30,
          siteId: null,
          categoryId: null,
          contractorId: null,
          notes: lastReviewed ? `Last reviewed ${formatDay(lastReviewed)}, before the yearly review was set up here.` : null,
        } as any,
      });
      setLastReviewed("");
    } catch {
      /* the mutation hook shows the error */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg"><CalendarCheck className="h-5 w-5 text-primary" />Yearly HACCP review</CardTitle>
        <CardDescription>
          Review your HACCP plan at least once a year, and whenever your menu, suppliers, equipment or processes change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {reviews.map((item) => (
          <div key={item.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="haccp-review">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/items/${item.id}`} className="font-medium hover:underline">{item.title}</Link>
                {item.siteName && <span className="text-sm text-muted-foreground">{item.siteName}</span>}
                {dueBadge(item)}
              </div>
              <p className="text-xs text-muted-foreground">
                {item.completedAt ? `Last reviewed ${formatDay(item.completedAt)}`
                  : item.notes?.startsWith("Last reviewed") ? item.notes.replace(/, before .*$/, "")
                  : "No review recorded here yet"}
                {item.frequencyMonths ? ` · every ${item.frequencyMonths} months` : ""}
              </p>
            </div>
            {canRecord && <Button size="sm" onClick={() => setRecording(item)}>Record review</Button>}
          </div>
        ))}
        {reviews.length === 0 && (canAdmin ? (
          <div className="space-y-3 rounded-md border border-dashed p-3">
            {hubSaidReviewed && (
              <p className="text-sm text-muted-foreground">Compliance Hub had your HACCP system marked as reviewed for this operation, with no date. Enter the date if you know it.</p>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="space-y-1 sm:w-72">
                <Label htmlFor="haccp-last-reviewed">Last reviewed (leave empty if not sure)</Label>
                <Input id="haccp-last-reviewed" type="date" max={today} value={lastReviewed} onChange={(e) => setLastReviewed(e.target.value)} />
              </div>
              <Button disabled={createItem.isPending || !!invalidDate} onClick={setUp}>Set up yearly review</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {invalidDate ? "The date cannot be in the future."
                : lastReviewed ? `Next review due ${formatDay(addMonths(lastReviewed, REVIEW_MONTHS))}.`
                : "With no date, the first review is due today."} It is added to Compliance Checks, with reminders.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No yearly HACCP review is set up yet. An Owner can set it up here.</p>
        ))}
      </CardContent>
      <CompleteCheckDialog item={recording} onClose={() => setRecording(null)} />
    </Card>
  );
}
