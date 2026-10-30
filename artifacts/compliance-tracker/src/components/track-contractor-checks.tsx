import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { HardHat } from "lucide-react";
import { useListComplianceItems, useListSites, type ComplianceItem } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { needsActionLabel } from "@/components/badges";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { complianceCheckDueState } from "@/lib/compliance-check-state";
import { formatDay } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

interface VisitType { key: string; module: string; title: string; label: string }
interface Visit { visitKey: string; siteId: number; notNeeded?: boolean }

type Rag = "red" | "amber" | "green" | "grey";

const RAG_STYLES: Record<Rag, { row: string; dot: string; word: string }> = {
  red: { row: "border-l-rose-500 bg-rose-50/50", dot: "bg-rose-500", word: "text-rose-700" },
  amber: { row: "border-l-amber-500 bg-amber-50/50", dot: "bg-amber-500", word: "text-amber-800" },
  green: { row: "border-l-emerald-500 bg-emerald-50/50", dot: "bg-emerald-500", word: "text-emerald-700" },
  grey: { row: "border-l-slate-400 bg-slate-50/50", dot: "bg-slate-400", word: "text-muted-foreground" },
};

const normalise = (title: string) => title.trim().toLowerCase();
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

function describe(item: ComplianceItem, now: number): { rag: Rag; text: string } {
  const state = complianceCheckDueState(item, now);
  const due = day(item.dueDate);
  if (state === "action") return { rag: "red", text: needsActionLabel(item) };
  if (state === "overdue") return { rag: "red", text: due ? `Overdue since ${formatDay(due)}` : "Overdue" };
  if (state === "due_soon") return { rag: "amber", text: `Due ${formatDay(due)}` };
  if (item.status === "completed") return { rag: "green", text: "Done" };
  return { rag: "green", text: due ? `Next due ${formatDay(due)}` : "No due date set" };
}

/**
 * The contractor checks a track keeps (FireTrack's fire alarm and
 * extinguisher services and annual emergency lighting test, for example),
 * shown on the track with the status of their compliance checks: red when
 * overdue or a certificate is outstanding or unsatisfactory, amber when due
 * within 30 days, green when in date. The compliance check is the one record
 * (contractor, certificate, done in house), so each row opens it; the track
 * itself records nothing here. The checks come from the business's contractor
 * visits (lib/contractorVisits.ts on the server), matched by title.
 */
export function TrackContractorChecks({ module, siteId }: { module: string; siteId?: number }) {
  const { activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();
  const { data: visitData, isError: visitsError } = useQuery<{ types: VisitType[]; visits: Visit[] }>({
    queryKey: ["contractor-visits", activeClientId],
    queryFn: async () => {
      const response = await clientApiFetch("/contractor-visits");
      if (!response.ok) throw new Error("Failed to load contractor visits");
      return response.json();
    },
    enabled: !!activeClientId,
  });
  const { data: items, isError: itemsError } = useListComplianceItems({});
  const { data: sites } = useListSites();

  if (visitsError || itemsError) {
    return <p role="alert" className="text-destructive text-sm">Contractor checks could not be loaded.</p>;
  }
  const types = (visitData?.types ?? []).filter((type) => type.module === module);
  if (!items || types.length === 0) return null;

  const now = Date.now();
  const siteName = new Map((sites ?? []).map((site) => [site.id, site.name]));
  const showSite = siteId === undefined && (sites?.length ?? 0) > 1;
  const allRows = types.flatMap((type) => {
    const checks = items.filter((item) => normalise(item.title) === normalise(type.title)
      && (siteId === undefined || item.siteId == null || item.siteId === siteId));
    if (!checks.length) {
      // Marked "No contractor needed" on the Contractors page (at this site,
      // or at every site when none is chosen).
      const visits = (visitData?.visits ?? []).filter((visit) => visit.visitKey === type.key
        && (siteId === undefined || visit.siteId === siteId));
      const notNeeded = visits.length > 0 && visits.every((visit) => visit.notNeeded);
      return [{ type, item: null as ComplianceItem | null, notNeeded }];
    }
    return checks.map((item) => ({ type, item, notNeeded: false }));
  });
  // Lines marked N/A on the Contractors page are hidden until added back there.
  const rows = allRows.filter((row) => !row.notNeeded);
  const hidden = allRows.length - rows.length;
  const setUpLink = (key: string) =>
    `/contractors?${new URLSearchParams({ visit: key, ...(siteId !== undefined ? { site: String(siteId) } : {}) })}`;

  return (
    <Card className="p-4" data-testid={`track-contractor-checks-${module}`}>
      <div className="flex items-start gap-2 mb-3">
        <HardHat aria-hidden="true" className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div>
          <h2 className="font-display font-bold text-base">Contractor checks</h2>
          <p className="text-xs text-muted-foreground">
            Kept in Compliance Checks, where you mark each one done and add its certificate (or record that a competent person did it in house).
          </p>
        </div>
      </div>
      <ul className="space-y-2">
        {rows.map(({ type, item }) => {
          if (!item) {
            const style = RAG_STYLES.grey;
            return (
              <li key={type.key} className={cn("border-l-4 rounded-sm p-3 flex flex-wrap items-center justify-between gap-2", style.row)}
                data-testid="contractor-check-row" data-rag="grey">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{type.label}</p>
                  <p className={cn("text-xs", style.word)}>Not set up yet: choose a contractor, or N/A if none is needed</p>
                </div>
                <Link href={setUpLink(type.key)} className="text-xs text-primary font-medium hover:underline">Set it up →</Link>
              </li>
            );
          }
          const { rag, text } = describe(item, now);
          const style = RAG_STYLES[rag];
          const lastDone = day(item.completedAt);
          const detail = [
            showSite ? (item.siteId == null ? "All sites" : siteName.get(item.siteId) ?? item.siteName) : null,
            lastDone ? `Last done ${formatDay(lastDone)}${item.completedInHouseBy ? ` in house by ${item.completedInHouseBy}` : ""}` : null,
            item.contractorName ? `Contractor: ${item.contractorName}` : null,
          ].filter(Boolean).join(" · ");
          return (
            <li key={`${type.key}:${item.id}`}>
              <Link href={`/items/${item.id}`}
                className={cn("border-l-4 rounded-sm p-3 flex flex-wrap items-center justify-between gap-2 hover:shadow-sm transition-shadow", style.row)}
                data-testid="contractor-check-row" data-rag={rag}>
                <div className="min-w-0">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <span aria-hidden="true" className={cn("inline-block w-2 h-2 rounded-full", style.dot)} />
                    {type.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <span className={cn("font-semibold", style.word)}>{text}</span>
                    {detail && <> · {detail}</>}
                  </p>
                </div>
                <span className="text-xs text-primary font-medium">Open check →</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No contractor checks needed here.</p>}
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground mt-2" data-testid="contractor-checks-hidden">
          {hidden} marked N/A (no contractor needed) and hidden.{" "}
          <Link href="/contractors" className="text-primary font-medium hover:underline">Add back on the Contractors page</Link>
        </p>
      )}
    </Card>
  );
}
