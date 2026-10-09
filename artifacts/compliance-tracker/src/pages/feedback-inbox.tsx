import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { FeedbackReport, FeedbackReportConflict, FeedbackReviewEvent } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { getApiErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Inbox, RefreshCw, X, AlertTriangle, Lock, History } from "lucide-react";

type Status = "new" | "reviewing" | "resolved";
const ALL = "all";
const CATEGORY_LABELS: Record<string, string> = { feedback: "Feedback", bug: "Bug", feature: "Feature request" };
const STATUS_LABELS: Record<Status, string> = { new: "New", reviewing: "Reviewing", resolved: "Resolved" };
const STATUS_STYLES: Record<Status, string> = {
  new: "bg-[#162D42] text-white",
  reviewing: "bg-primary/30 text-[#162D42]",
  resolved: "bg-muted text-muted-foreground",
};
const NOTE_MAX = 5000;

type DraftBase = { revision: number; status: Status; note: string };
const baseOf = (r: FeedbackReport): DraftBase => ({ revision: r.revision, status: r.status, note: r.internalNote ?? "" });

class SaveConflictError extends Error {
  constructor(message: string, readonly latest: FeedbackReport) { super(message); }
}

function fmt(d: string | null) {
  if (!d) return "";
  return new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function FeedbackInboxPage() {
  const canAdmin = useCanAdmin();
  const { activeClientId } = useAuth();
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftStatus, setDraftStatus] = useState<Status>("new");
  const [draftNote, setDraftNote] = useState("");
  // The saved version the draft started from; its revision is sent with the
  // save so the API rejects (409) a draft another manager has superseded.
  const [base, setBase] = useState<DraftBase | null>(null);
  // A newer saved version the user has not yet chosen to keep or discard.
  const [conflict, setConflict] = useState<FeedbackReport | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const clientRef = useRef(activeClientId);
  clientRef.current = activeClientId;

  const params = new URLSearchParams();
  if (category !== ALL) params.set("category", category);
  if (status !== ALL) params.set("status", status);
  const qs = params.toString();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<FeedbackReport[]>({
    queryKey: ["feedback", activeClientId, category, status],
    enabled: canAdmin && !!activeClientId,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const res = await api(`/feedback${qs ? `?${qs}` : ""}`, { signal });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load feedback."));
      return res.json();
    },
  });

  // Tenant switch: close report and discard drafts.
  useEffect(() => {
    setSelectedId(null);
    setDraftNote("");
    setBase(null);
    setConflict(null);
    setSaveError(null);
    setCategory(ALL);
    setStatus(ALL);
  }, [activeClientId]);

  const selected = data?.find(r => r.id === selectedId) ?? null;
  const dirty = !!base && (draftStatus !== base.status || draftNote !== base.note);
  // Keep showing a report with an unsaved draft even if a refresh drops it
  // from the filtered list (for example another manager changed its status).
  const lastSeen = useRef<FeedbackReport | null>(null);
  if (selected) lastSeen.current = selected;
  const shown = selected
    ?? (selectedId !== null && dirty && lastSeen.current?.id === selectedId ? (conflict ?? lastSeen.current) : null);
  useEffect(() => {
    if (selectedId !== null && data && !selected && !dirty) setSelectedId(null);
  }, [data, selected, selectedId, dirty]);

  // A refresh that brings a newer saved version: adopt it when the draft is
  // untouched, otherwise keep the draft and offer the saved version alongside.
  useEffect(() => {
    if (!selected || !base || selected.revision <= base.revision) return;
    if (!dirty) {
      setBase(baseOf(selected));
      setDraftStatus(selected.status);
      setDraftNote(selected.internalNote ?? "");
    } else if (!conflict || conflict.revision < selected.revision) {
      setConflict(selected);
    }
  }, [selected, base, dirty, conflict]);

  const history = useQuery<FeedbackReviewEvent[]>({
    // Keyed by revision so a newly saved version refetches its history.
    queryKey: ["feedback-history", activeClientId, selectedId, shown?.revision ?? null],
    enabled: canAdmin && !!activeClientId && selectedId !== null,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const res = await api(`/feedback/${selectedId}/history`, { signal });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load review history."));
      return res.json();
    },
  });

  function open(r: FeedbackReport) {
    setSelectedId(r.id);
    setDraftStatus(r.status);
    setDraftNote(r.internalNote ?? "");
    setBase(baseOf(r));
    setConflict(null);
    setSaveError(null);
  }
  function close() { setSelectedId(null); setDraftNote(""); setBase(null); setConflict(null); setSaveError(null); }

  // Keep my draft: rebase it on the latest saved version so the next save
  // deliberately replaces that version.
  function keepDraft() {
    if (!conflict) return;
    setBase(baseOf(conflict));
    setConflict(null);
    setSaveError(null);
  }
  function adoptSavedVersion() {
    if (!conflict) return;
    setBase(baseOf(conflict));
    setDraftStatus(conflict.status);
    setDraftNote(conflict.internalNote ?? "");
    setConflict(null);
    setSaveError(null);
  }

  // Publish a saved report immediately: reopening while the refetch is in
  // flight must not initialise a new draft from the previous note.
  function publish(report: FeedbackReport, clientId: string | number | null) {
    for (const [key, rows] of queryClient.getQueriesData<FeedbackReport[]>({
      queryKey: ["feedback", clientId],
    })) {
      if (!rows) continue;
      queryClient.setQueryData(key, rows
        .map(row => row.id === report.id ? report : row)
        .filter(row => (key[2] === ALL || row.category === key[2])
          && (key[3] === ALL || row.status === key[3])));
    }
  }

  const save = useMutation({
    mutationFn: async (vars: {
      id: number; clientId: string | number | null; expectedRevision: number; status: Status; internalNote: string;
    }) => {
      const res = await api(`/feedback/${vars.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: vars.expectedRevision, status: vars.status, internalNote: vars.internalNote }),
      });
      if (res.status === 409) {
        const body = await res.clone().json().catch(() => null) as Partial<FeedbackReportConflict> | null;
        const message = await getApiErrorMessage(res, "Another manager saved this report after you opened it.");
        if (body?.report && typeof body.report.revision === "number") throw new SaveConflictError(message, body.report);
        throw new Error(message);
      }
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not save changes."));
      return (await res.json()) as FeedbackReport;
    },
    onSuccess: (report, vars) => {
      publish(report, vars.clientId);
      queryClient.invalidateQueries({ queryKey: ["feedback", vars.clientId] });
      if (clientRef.current === vars.clientId) close();
    },
    onError: (e, vars) => {
      if (e instanceof SaveConflictError) {
        publish(e.latest, vars.clientId);
        queryClient.invalidateQueries({ queryKey: ["feedback", vars.clientId] });
      }
      if (clientRef.current !== vars.clientId) return;
      // The draft fields are left untouched so the unsaved note survives.
      if (e instanceof SaveConflictError) setConflict(e.latest);
      setSaveError(e instanceof Error ? e.message : "Could not save changes.");
    },
  });

  if (!canAdmin) {
    return <AppLayout title="Feedback inbox"><p className="text-sm text-muted-foreground">Only administrators can view feedback.</p></AppLayout>;
  }

  return (
    <AppLayout title="Feedback inbox">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground mr-auto">Reports submitted by people at this client.</p>
          <Select value={category} onValueChange={setCategory} disabled={save.isPending}>
            <SelectTrigger className="w-44" aria-label="Filter by feedback type" data-testid="filter-category"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus} disabled={save.isPending}>
            <SelectTrigger className="w-40" aria-label="Filter by feedback status" data-testid="filter-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {(Object.keys(STATUS_LABELS) as Status[]).map(k => <SelectItem key={k} value={k}>{STATUS_LABELS[k]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh" data-testid="button-refresh-feedback">
            <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start">
          <div className="border bg-card divide-y" data-testid="list-feedback">
            {isLoading && Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="p-4 space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>
            ))}
            {isError && (
              <div className="p-6 text-center space-y-3" data-testid="error-feedback">
                <AlertTriangle className="w-6 h-6 mx-auto text-destructive" />
                <p className="text-sm">{error instanceof Error ? error.message : "Could not load feedback."}</p>
                <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-retry-feedback">Try again</Button>
              </div>
            )}
            {!isLoading && !isError && data?.length === 0 && (
              <div className="p-10 text-center space-y-2" data-testid="empty-feedback">
                <Inbox className="w-7 h-7 mx-auto text-muted-foreground" />
                <p className="font-display text-lg text-[#162D42]">Nothing here</p>
                <p className="text-sm text-muted-foreground">
                  {category !== ALL || status !== ALL ? "No reports match these filters." : "No feedback has been submitted yet."}
                </p>
              </div>
            )}
            {data?.map(r => (
              <button
                key={r.id}
                onClick={() => open(r)}
                disabled={save.isPending}
                data-testid={`row-feedback-${r.id}`}
                className={`w-full text-left p-4 transition-colors hover:bg-muted/60 ${r.id === selectedId ? "bg-muted" : ""}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Badge className={`rounded-sm ${STATUS_STYLES[r.status]}`}>{STATUS_LABELS[r.status]}</Badge>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{CATEGORY_LABELS[r.category]}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{fmt(r.createdAt)}</span>
                </div>
                <p className={`text-sm truncate ${r.status === "new" ? "font-semibold" : ""}`}>{r.summary}</p>
                <p className="text-xs text-muted-foreground truncate">{r.submitterName ?? "Unknown submitter"}</p>
              </button>
            ))}
          </div>

          <div className="border bg-card min-h-[200px] lg:sticky lg:top-4" data-testid="panel-feedback-detail">
            {!shown ? (
              <div className="p-10 text-center text-sm text-muted-foreground">Select a report to read it in full.</div>
            ) : (
              <div className="p-5 space-y-5 animate-in fade-in duration-200" key={shown.id}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{CATEGORY_LABELS[shown.category]}</p>
                    <h2 className="font-display text-2xl break-words" data-testid="text-feedback-summary">{shown.summary}</h2>
                  </div>
                  <Button variant="ghost" size="icon" onClick={close} disabled={save.isPending} aria-label="Close report" data-testid="button-close-feedback"><X className="w-4 h-4" /></Button>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-xs text-muted-foreground">Submitted by</dt><dd>{shown.submitterName ?? "Unknown"}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Received</dt><dd>{fmt(shown.createdAt)}</dd></div>
                  <div className="col-span-2"><dt className="text-xs text-muted-foreground">Page</dt><dd className="font-mono text-xs break-all" data-testid="text-feedback-path">{shown.pagePath ?? "Not recorded"}</dd></div>
                  {shown.updatedAt && <div className="col-span-2"><dt className="text-xs text-muted-foreground">Last updated</dt><dd>{fmt(shown.updatedAt)}{shown.updatedByName ? ` by ${shown.updatedByName}` : ""}</dd></div>}
                </dl>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Details</p>
                  <p className="text-sm whitespace-pre-wrap break-words bg-muted/50 p-3" data-testid="text-feedback-details">{shown.details}</p>
                </div>
                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Lock className="w-3.5 h-3.5" />
                    Internal only. Status and notes are not emailed to the submitter.
                  </div>
                  <Select value={draftStatus} onValueChange={v => setDraftStatus(v as Status)} disabled={save.isPending}>
                    <SelectTrigger className="w-48" aria-label="Report status" data-testid="select-feedback-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(STATUS_LABELS) as Status[]).map(k => <SelectItem key={k} value={k}>{STATUS_LABELS[k]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div>
                    <Textarea
                      aria-label="Internal response note"
                      value={draftNote}
                      maxLength={NOTE_MAX}
                      rows={5}
                      disabled={save.isPending}
                      onChange={e => setDraftNote(e.target.value)}
                      placeholder="Internal note (visible to administrators only)"
                      data-testid="input-feedback-note"
                    />
                    <p className="text-xs text-muted-foreground text-right mt-1">{draftNote.length}/{NOTE_MAX}</p>
                  </div>
                  {saveError && !conflict && (
                    <p className="text-sm text-destructive" role="alert" data-testid="error-feedback-save">{saveError}</p>
                  )}
                  {conflict && (
                    <div className="border border-amber-300 bg-amber-50 p-3 space-y-2 text-sm" role="alert" data-testid="panel-feedback-conflict">
                      <p className="font-medium text-[#162D42]">
                        {conflict.updatedByName ?? "Another manager"} saved a newer version
                        {conflict.updatedAt ? ` at ${fmt(conflict.updatedAt)}` : ""}. Your draft above has not been saved.
                      </p>
                      <div>
                        <p className="text-xs text-muted-foreground">Latest saved status</p>
                        <p data-testid="text-conflict-saved-status">{STATUS_LABELS[conflict.status]}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Latest saved note</p>
                        <p className="whitespace-pre-wrap break-words bg-white/70 p-2" data-testid="text-conflict-saved-note">
                          {conflict.internalNote || <span className="text-muted-foreground">No note</span>}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={keepDraft} data-testid="button-conflict-keep-draft">Keep my draft</Button>
                        <Button size="sm" variant="outline" onClick={adoptSavedVersion} data-testid="button-conflict-use-saved">Use saved version</Button>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      disabled={!dirty || save.isPending || !!conflict || !base}
                      onClick={() => {
                        if (!base) return;
                        setSaveError(null);
                        save.mutate({
                          id: shown.id, clientId: activeClientId, expectedRevision: base.revision,
                          status: draftStatus, internalNote: draftNote,
                        });
                      }}
                      data-testid="button-save-feedback"
                    >
                      {save.isPending ? "Saving..." : saveError && !conflict ? "Retry save" : "Save changes"}
                    </Button>
                    <Button variant="ghost" onClick={close} disabled={save.isPending}>Cancel</Button>
                    {dirty && !save.isPending && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
                  </div>
                </div>
                <div className="space-y-3 border-t pt-4" data-testid="section-feedback-history">
                  <div className="flex items-center gap-2 text-sm font-medium text-[#162D42]">
                    <History className="w-4 h-4" /> Review history
                  </div>
                  {history.isLoading && <Skeleton className="h-10 w-full" />}
                  {history.isError && (
                    <div className="flex items-center gap-2 text-sm text-destructive" data-testid="error-feedback-history">
                      {history.error instanceof Error ? history.error.message : "Could not load review history."}
                      <Button variant="outline" size="sm" onClick={() => history.refetch()}>Try again</Button>
                    </div>
                  )}
                  {history.data?.length === 0 && (
                    <p className="text-sm text-muted-foreground" data-testid="empty-feedback-history">No review changes recorded yet.</p>
                  )}
                  {!!history.data?.length && (
                    <ol className="space-y-3" data-testid="list-feedback-history">
                      {history.data.map(entry => (
                        <li key={entry.id} className="border-l-2 border-primary/40 pl-3 text-sm" data-testid={`history-entry-${entry.revision}`}>
                          <p>
                            <span className="font-medium" data-testid="text-history-actor">{entry.actorName ?? "Former user"}</span>
                            <span className="text-xs text-muted-foreground"> · {fmt(entry.createdAt)}</span>
                          </p>
                          <p className="text-xs text-muted-foreground" data-testid="text-history-status">
                            {entry.previousStatus === entry.status
                              ? `Status: ${STATUS_LABELS[entry.status]}`
                              : `${STATUS_LABELS[entry.previousStatus]} → ${STATUS_LABELS[entry.status]}`}
                          </p>
                          {entry.internalNote !== entry.previousInternalNote && (
                            entry.internalNote
                              ? <p className="whitespace-pre-wrap break-words mt-1" data-testid="text-history-note">{entry.internalNote}</p>
                              : <p className="text-xs italic text-muted-foreground mt-1" data-testid="text-history-note">Note cleared</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
