import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { CalendarX2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useAuth } from "@/context/auth-context";

export interface CalendarCancellationRecord {
  id: number;
  issueId: number;
  jobTitle: string | null;
  eventDate: string | null;
  contractorId: number | null;
  contractorName: string | null;
  sentTo: string;
  status: "sent" | "failed";
  sentByName: string | null;
  sentAt: string | null;
  lastFailedAt: string | null;
  failedAttempts: number;
}

export const calendarCancellationHistoryKey = ["calendar-cancellations"] as const;

/** Sent calendar cancellations, and ones whose last send failed and still
 *  await a manager retry. Shown to managers only (the API refuses others). */
export function CalendarCancellationHistory({ contractorId }: { contractorId?: number }) {
  const { activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();
  const { data: records = [], isLoading, isError } = useQuery<CalendarCancellationRecord[]>({
    queryKey: [...calendarCancellationHistoryKey, activeClientId, contractorId ?? null],
    queryFn: async () => {
      const query = contractorId ? `?contractorId=${contractorId}` : "";
      const response = await clientApiFetch(`/fix-track/calendar-cancellations${query}`);
      if (!response.ok) throw new Error("Failed to load calendar cancellations");
      return response.json();
    },
    enabled: !!activeClientId,
  });

  return (
    <Card role="region" className="shadow-lg border-border/50 overflow-hidden" aria-labelledby="calendar-cancellation-history">
      <div className="p-6 bg-muted/20 border-b border-border/50">
        <h3 id="calendar-cancellation-history" className="font-display text-lg font-bold flex items-center gap-2">
          <CalendarX2 className="w-5 h-5 text-amber-600" /> Calendar cancellations
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          {contractorId
            ? "Cancellations sent to this contractor, and any whose send failed"
            : "Recently sent cancellations, and any whose send failed"}
        </p>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-muted-foreground text-sm">Loading…</div>
      ) : isError ? (
        <div className="p-6 text-center text-destructive text-sm">We couldn't load calendar cancellations.</div>
      ) : records.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground text-sm">No calendar cancellations sent yet.</div>
      ) : (
        <ul className="divide-y divide-border/40">
          {records.map(record => (
            <li key={record.id} className="px-4 py-3 text-sm flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{record.jobTitle || "Untitled job"}</p>
                <p className="text-muted-foreground">
                  {record.eventDate
                    ? `Event on ${format(new Date(`${record.eventDate}T00:00:00`), "dd MMM yyyy")}`
                    : "Event date not recorded"}
                  {" · "}
                  {!contractorId && record.contractorName ? `${record.contractorName}, ` : ""}
                  {record.sentTo}
                </p>
              </div>
              {record.status === "sent" ? (
                <div className="sm:text-right shrink-0">
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Sent
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {record.sentAt ? format(new Date(record.sentAt), "dd MMM yyyy, HH:mm") : ""}
                    {record.sentByName ? ` by ${record.sentByName}` : ""}
                  </p>
                  {record.failedAttempts > 0 && (
                    <p className="text-xs text-muted-foreground">
                      After {record.failedAttempts} failed {record.failedAttempts === 1 ? "attempt" : "attempts"}
                    </p>
                  )}
                </div>
              ) : (
                <div className="sm:text-right shrink-0">
                  <span className="inline-flex items-center gap-1 text-destructive font-medium">
                    <AlertTriangle className="w-4 h-4" aria-hidden="true" /> Send failed
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {record.lastFailedAt ? `${format(new Date(record.lastFailedAt), "dd MMM yyyy, HH:mm")} · ` : ""}
                    Not sent, awaiting a retry in{" "}
                    <Link href="/contractor-approvals" className="underline">Contractor Approvals</Link>
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
