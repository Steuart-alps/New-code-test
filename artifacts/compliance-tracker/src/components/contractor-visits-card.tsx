import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { formatDay, localToday } from "@/lib/onboarding";

interface VisitType {
  key: string;
  trackLabel: string;
  label: string;
  description: string;
  dueFrom: "track" | "later" | "check";
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
}

interface Contractor { id: number; name: string; company?: string | null }

const NONE = "none";
const ALL_SITES = "all";

/**
 * The contractor visits the business's tracks keep (pest control, water
 * system servicing, fire servicing and others), each with the contractor who
 * gets the reminder email before it is due.
 */
export function ContractorVisitsCard({ contractors }: { contractors: Contractor[] }) {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const clientApiFetch = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [siteFilter, setSiteFilter] = useState(ALL_SITES);

  const { data, isLoading, isError } = useQuery<{ types: VisitType[]; visits: Visit[] }>({
    queryKey: ["contractor-visits", activeClientId],
    queryFn: async () => {
      const response = await clientApiFetch("/contractor-visits");
      if (!response.ok) throw new Error("Failed to load contractor visits");
      return response.json();
    },
    enabled: !!activeClientId,
  });

  const save = useMutation({
    mutationFn: async (body: { visitKey: string; siteId: number; contractorId: number | null; dueDate?: string | null }) => {
      const response = await clientApiFetch("/contractor-visits", { method: "PUT", body: JSON.stringify(body) });
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
    return [...byId].map(([id, name]) => ({ id, name }));
  }, [data]);

  if (isLoading || !data || data.types.length === 0) {
    return isError ? <p role="alert" className="text-destructive text-sm mb-8">Could not load contractor visits.</p> : null;
  }

  const today = localToday();
  const visible = data.visits.filter(visit => siteFilter === ALL_SITES || String(visit.siteId) === siteFilter);
  const groups = [...new Set(data.types.map(type => type.trackLabel))];
  const typeByKey = new Map(data.types.map(type => [type.key, type]));
  const showSite = sites.length > 1 && siteFilter === ALL_SITES;

  return (
    <Card className="p-5 mb-8 bg-card/60 border-border/50">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-display font-bold text-lg flex items-center gap-2">
            <CalendarClock aria-hidden="true" className="w-5 h-5 text-primary" /> Contractor visits
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Visits your tracks keep, with when each is next due. Choose who does each one: they get one reminder email before it is due
            (your lead time), which waits in Contractor Approvals for a manager to send.
          </p>
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
        {groups.map(group => {
          const rows = visible.filter(visit => typeByKey.get(visit.visitKey)?.trackLabel === group);
          if (!rows.length) return null;
          return (
            <section key={group} aria-label={group}>
              <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wide mb-2">{group}</h3>
              <ul className="divide-y divide-border/60 rounded-sm border border-border/60">
                {rows.map(visit => {
                  const type = typeByKey.get(visit.visitKey)!;
                  const due = visit.dueDate ?? visit.trackDueDate;
                  const overdue = !!due && due < today && visit.status !== "completed";
                  const label = `${type.label}${showSite ? ` at ${visit.siteName}` : ""}`;
                  return (
                    <li key={`${visit.visitKey}@${visit.siteId}`} className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 p-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{type.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {showSite && <>{visit.siteName} · </>}
                          {due
                            ? <span className={overdue ? "text-rose-700 font-semibold" : undefined}>{overdue ? "Overdue since" : "Next due"} {formatDay(due)}</span>
                            : type.dueFrom === "check" ? "Set the date it is due" : "No date yet: set one, or record the last visit on the track"}
                          {visit.reminderSentAt && <> · Reminder sent</>}
                        </p>
                      </div>
                      {(type.dueFrom === "check" || !visit.trackDueDate) && canAdmin && (
                        <Input
                          type="date"
                          aria-label={`Due date: ${label}`}
                          className="w-full md:w-40"
                          defaultValue={visit.dueDate ?? ""}
                          onBlur={event => {
                            const value = event.target.value || null;
                            if (value !== visit.dueDate) save.mutate({ visitKey: visit.visitKey, siteId: visit.siteId, contractorId: visit.contractorId, dueDate: value });
                          }}
                        />
                      )}
                      {canAdmin ? (
                        <Select
                          value={visit.contractorId != null ? String(visit.contractorId) : NONE}
                          onValueChange={value => save.mutate({
                            visitKey: visit.visitKey, siteId: visit.siteId, contractorId: value === NONE ? null : Number(value),
                          })}
                          disabled={save.isPending}
                        >
                          <SelectTrigger className="w-full md:w-64" aria-label={`Contractor: ${label}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>No contractor (no reminder)</SelectItem>
                            {contractors.map(contractor => (
                              <SelectItem key={contractor.id} value={String(contractor.id)}>
                                {[contractor.name, contractor.company].filter(Boolean).join(", ")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-sm md:w-64">{visit.contractorName ?? "No contractor"}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Card>
  );
}
