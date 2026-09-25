import { useQuery } from "@tanstack/react-query";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";

export type AuditModule = "fire" | "legionella" | "kitchen" | "fix" | "safe" | "train" | "doc" | "incidents";

type Change = { before: unknown; after: unknown };
type AuditEntry = {
  id: number;
  tableName: string;
  rowId: number;
  action: string;
  changedBy: number | null;
  changedAt: string;
  diff: Record<string, Change> | null;
  actorName: string | null;
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value || "(empty)";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function AuditLog({ module }: { module: AuditModule }) {
  const { activeClientId, user } = useAuth();
  const canAdmin = useCanAdmin();
  const clientApiFetch = useActiveClientApi();
  const { data, isLoading, error } = useQuery<AuditEntry[]>({
    queryKey: ["audit-log", module, activeClientId, user?.id],
    enabled: canAdmin && (user?.role !== "consultant" || activeClientId != null),
    staleTime: 30_000,
    queryFn: async () => {
      const response = await clientApiFetch(`/audit-log?module=${encodeURIComponent(module)}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not load audit log (${response.status})`);
      }
      const entries: unknown = await response.json();
      if (!Array.isArray(entries)) throw new Error("Unexpected audit log response");
      return entries as AuditEntry[];
    },
  });

  if (!canAdmin) return null;
  if (user?.role === "consultant" && activeClientId == null) {
    return <p className="text-sm text-muted-foreground py-6" data-testid="status-audit-select-client">Select a client to view its audit log.</p>;
  }
  if (isLoading) return <p className="text-sm text-muted-foreground py-6" data-testid="status-audit-loading">Loading audit log…</p>;
  if (error) return <p className="text-sm text-destructive py-6" role="alert" data-testid="status-audit-error">{error instanceof Error ? error.message : "Could not load audit log."}</p>;
  if (!data?.length) return <p className="text-sm text-muted-foreground py-6" data-testid="status-audit-empty">No changes recorded yet.</p>;

  return (
    <div className="space-y-3 py-3" data-testid={`list-audit-${module}`}>
      {data.map(entry => {
        const date = new Date(entry.changedAt);
        const changes = Object.entries(entry.diff ?? {});
        return (
          <article key={entry.id} className="rounded-md border border-border bg-card p-3 text-sm" data-testid={`card-audit-${entry.id}`}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium capitalize" data-testid={`text-audit-action-${entry.id}`}>{entry.action.replace(/_/g, " ")}</span>
              <span className="text-muted-foreground">{entry.tableName.replace(/_/g, " ")} #{entry.rowId}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-audit-actor-${entry.id}`}>
              {entry.changedBy == null ? "System" : entry.actorName || `Former user (ID ${entry.changedBy})`}
              {" · "}
              <time dateTime={entry.changedAt}>{Number.isNaN(date.getTime()) ? entry.changedAt : date.toLocaleString()}</time>
            </p>
            {changes.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-primary" data-testid={`button-audit-changes-${entry.id}`}>
                  Inspect {changes.length} field {changes.length === 1 ? "change" : "changes"}
                </summary>
                <div className="mt-2 divide-y divide-border rounded-md border border-border">
                  {changes.map(([field, change]) => (
                    <div key={field} className="p-2" data-testid={`text-audit-field-${entry.id}-${field}`}>
                      <div className="font-medium break-all">{field.replace(/_/g, " ")}</div>
                      <div className="mt-1 grid gap-2 sm:grid-cols-2">
                        <div className="min-w-0"><span className="text-xs text-muted-foreground">Before</span><pre className="whitespace-pre-wrap break-all font-sans">{displayValue(change?.before)}</pre></div>
                        <div className="min-w-0"><span className="text-xs text-muted-foreground">After</span><pre className="whitespace-pre-wrap break-all font-sans">{displayValue(change?.after)}</pre></div>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </article>
        );
      })}
    </div>
  );
}