import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";

export type PublicLinkType = "sign_off" | "contractor_portal" | "fix_track_action" | "fix_track_quote";
type ActionType = "view" | "submit";

type AccessEntry = {
  id: number;
  linkType: PublicLinkType;
  actionType: ActionType;
  activity: string;
  linkRef: string;
  occurredAt: string;
};
type AccessPage = { entries: AccessEntry[]; nextCursor: string | null };

export const PUBLIC_LINK_LABELS: Record<PublicLinkType, string> = {
  sign_off: "Staff sign-off link",
  contractor_portal: "Contractor portal",
  fix_track_action: "FixTrack job link",
  fix_track_quote: "FixTrack quote link",
};

// Local calendar day boundaries as instants, so "to" includes the whole day.
function dayStart(value: string): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function dayAfter(value: string): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

/**
 * Manager-only history of public-link use (sign-off, contractor portal and
 * FixTrack links). The API returns no tokens, only a short link reference
 * derived from a one-way fingerprint, so nothing here can be reused as a link.
 */
export function PublicLinkAccessHistory({ linkType: fixedType }: { linkType?: PublicLinkType }) {
  const { activeClientId, user } = useAuth();
  const canAdmin = useCanAdmin();
  const clientApiFetch = useActiveClientApi();
  const [linkType, setLinkType] = useState<PublicLinkType | "all">(fixedType ?? "all");
  const [actionType, setActionType] = useState<ActionType | "all">("all");
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");

  const filters = new URLSearchParams();
  const effectiveType = fixedType ?? (linkType === "all" ? null : linkType);
  if (effectiveType) filters.set("linkType", effectiveType);
  if (actionType !== "all") filters.set("actionType", actionType);
  const from = dayStart(fromDay);
  const to = dayAfter(toDay);
  if (from) filters.set("from", from);
  if (to) filters.set("to", to);
  const filterKey = filters.toString();

  const query = useInfiniteQuery<AccessPage>({
    queryKey: ["public-link-access", activeClientId, user?.id, filterKey],
    enabled: canAdmin && (user?.role !== "consultant" || activeClientId != null),
    staleTime: 30_000,
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(filterKey);
      if (typeof pageParam === "string") params.set("cursor", pageParam);
      const qs = params.toString();
      const response = await clientApiFetch(`/public-link-access${qs ? `?${qs}` : ""}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not load link access history (${response.status})`);
      }
      const page = await response.json() as AccessPage;
      if (!page || !Array.isArray(page.entries)) throw new Error("Unexpected link access response");
      return page;
    },
  });

  if (!canAdmin) return null;
  if (user?.role === "consultant" && activeClientId == null) {
    return <p className="text-sm text-muted-foreground py-6" data-testid="status-link-access-select-client">Select a client to view its link access history.</p>;
  }

  const entries = query.data?.pages.flatMap(page => page.entries) ?? [];
  const hasFilters = (!fixedType && linkType !== "all") || actionType !== "all" || fromDay !== "" || toDay !== "";

  return (
    <div className="space-y-4 py-3" data-testid="panel-link-access">
      <p className="text-sm text-muted-foreground">
        Each time someone opens or uses a public link, ComplyTrack records the link type, what was done and when.
        Link tokens are never stored or shown. The link reference is a one-way code that matches repeat use of the same link.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!fixedType && (
          <div className="space-y-1.5">
            <Label htmlFor="link-access-type">Link type</Label>
            <Select value={linkType} onValueChange={value => setLinkType(value as PublicLinkType | "all")}>
              <SelectTrigger id="link-access-type" data-testid="select-link-access-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All links</SelectItem>
                {(Object.keys(PUBLIC_LINK_LABELS) as PublicLinkType[]).map(key => (
                  <SelectItem key={key} value={key}>{PUBLIC_LINK_LABELS[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="link-access-action">Action</Label>
          <Select value={actionType} onValueChange={value => setActionType(value as ActionType | "all")}>
            <SelectTrigger id="link-access-action" data-testid="select-link-access-action"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Views and submissions</SelectItem>
              <SelectItem value="view">Views only</SelectItem>
              <SelectItem value="submit">Submissions only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="link-access-from">From</Label>
          <Input id="link-access-from" type="date" value={fromDay} max={toDay || undefined} onChange={event => setFromDay(event.target.value)} data-testid="input-link-access-from" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="link-access-to">To</Label>
          <Input id="link-access-to" type="date" value={toDay} min={fromDay || undefined} onChange={event => setToDay(event.target.value)} data-testid="input-link-access-to" />
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground py-6" data-testid="status-link-access-loading">Loading link access history…</p>
      ) : query.error ? (
        <p className="text-sm text-destructive py-6" role="alert" data-testid="status-link-access-error">
          {query.error instanceof Error ? query.error.message : "Could not load link access history."}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6" data-testid="status-link-access-empty">
          {hasFilters ? "No link access matches these filters." : "No public link access recorded yet."}
        </p>
      ) : (
        <>
          <div className="rounded-md border border-border">
            <Table data-testid="table-link-access">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  {!fixedType && <TableHead>Link type</TableHead>}
                  <TableHead>Activity</TableHead>
                  <TableHead>Link ref</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(entry => {
                  const date = new Date(entry.occurredAt);
                  return (
                    <TableRow key={entry.id} data-testid={`row-link-access-${entry.id}`}>
                      <TableCell className="whitespace-nowrap">
                        <time dateTime={entry.occurredAt}>{Number.isNaN(date.getTime()) ? entry.occurredAt : date.toLocaleString()}</time>
                      </TableCell>
                      {!fixedType && <TableCell>{PUBLIC_LINK_LABELS[entry.linkType] ?? entry.linkType}</TableCell>}
                      <TableCell>
                        {entry.activity}
                        <span className="ml-2 text-xs text-muted-foreground">{entry.actionType === "view" ? "View" : "Submission"}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{entry.linkRef}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {query.hasNextPage && (
            <Button variant="outline" size="sm" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage} data-testid="button-link-access-more">
              {query.isFetchingNextPage ? "Loading…" : "Show older access"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
