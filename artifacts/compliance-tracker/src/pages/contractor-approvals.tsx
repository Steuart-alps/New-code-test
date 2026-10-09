import React, { useEffect, useState, useMemo, useRef } from "react";
import { AppLayout } from "@/components/layout";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { 
  CheckCircle2, Search, Building, MapPin, RefreshCw,
  ChevronDown, ChevronRight, Loader2, Pencil, Send, CalendarX2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  approveContractorEmail,
  dismissContractorEmail,
} from "@/lib/contractor-approval-actions";
import {
  getApprovalRefreshStorageKey,
  readPersistedApprovalRefreshState,
  persistApprovalRefreshState,
  subscribeToApprovalRefreshStorage,
} from "@/lib/contractor-approval-refresh-state";

interface EmailQueueItem {
  id: number;
  entityType: string;
  entityId: number;
  contractorId: number | null;
  emailType: string;
  status: string;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  emailPreviewJson: any; // has { subject: string, text: string, html: string }
  siteName: string | null;
  contractorName: string | null;
  jobTitle: string | null;
  quote?: any;
}

type PendingCancellationConfirmation =
  | {
      action: "approve";
      item: EmailQueueItem;
      modifiedPreview?: { subject: string; text: string };
    }
  | {
      action: "dismiss";
      item: EmailQueueItem;
    };

export default function ContractorApprovalsPage() {
  const [items, setItems] = useState<EmailQueueItem[]>([]);
  const { activeClientId, user } = useAuth();
  const clientApiFetch = useActiveClientApi();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { toast } = useToast();
  const [expandedSites, setExpandedSites] = useState<Set<string>>(new Set());
  
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editText, setEditText] = useState("");
  const [submittingId, setSubmittingId] = useState<number | null>(null);
  const [pendingCancellationConfirmation, setPendingCancellationConfirmation] =
    useState<PendingCancellationConfirmation | null>(null);
  const [newRequestIds, setNewRequestIds] = useState<number[]>([]);
  const newRequestIdsRef = useRef<number[]>([]);
  const mountedRef = useRef(false);
  const fetchGenerationRef = useRef(0);
  const knownQueueIdsRef = useRef<Set<number> | null>(null);
  const refreshStorageKeyRef = useRef<string | null>(null);
  const approvalRefreshStorageKey = getApprovalRefreshStorageKey(
    user?.id ?? null,
    activeClientId,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const persistedState = readPersistedApprovalRefreshState(
      window,
      approvalRefreshStorageKey,
    );
    refreshStorageKeyRef.current = approvalRefreshStorageKey;
    setItems([]);
    newRequestIdsRef.current = persistedState?.newRequestIds ?? [];
    setNewRequestIds(newRequestIdsRef.current);
    knownQueueIdsRef.current = persistedState
      ? new Set(persistedState.knownQueueIds)
      : null;
    fetchItems();
  }, [activeClientId, approvalRefreshStorageKey, user?.id]);

  useEffect(() => {
    const storageKey = approvalRefreshStorageKey;
    if (!storageKey || typeof window === "undefined") return;

    return subscribeToApprovalRefreshStorage(window, storageKey, persistedState => {
      knownQueueIdsRef.current = new Set(persistedState.knownQueueIds);
      newRequestIdsRef.current = persistedState.newRequestIds;
      setNewRequestIds(persistedState.newRequestIds);
    });
  }, [approvalRefreshStorageKey]);

  async function fetchItems() {
    const fetchGeneration = ++fetchGenerationRef.current;
    setLoadError(null);
    setLoading(true);
    try {
      const res = await clientApiFetch("/fix-track/contractor-email-queue?status=pending");
      if (res.ok) {
        const nextItems = await res.json();
        if (mountedRef.current && fetchGeneration === fetchGenerationRef.current) {
          const nextQueueIds = new Set<number>(
            nextItems.map((item: EmailQueueItem) => item.id),
          );
          const previousQueueIds = knownQueueIdsRef.current;
          const stillPendingIds = new Set(
            newRequestIdsRef.current.filter(id => nextQueueIds.has(id)),
          );
          if (previousQueueIds) {
            const incomingNewIds = nextItems
              .filter((item: EmailQueueItem) => !previousQueueIds.has(item.id))
              .map((item: EmailQueueItem) => item.id);
            incomingNewIds.forEach((id: number) => stillPendingIds.add(id));
          }
          const nextNewRequestIds = Array.from(stillPendingIds);
          newRequestIdsRef.current = nextNewRequestIds;
          setNewRequestIds(nextNewRequestIds);
          knownQueueIdsRef.current = nextQueueIds;
           persistApprovalRefreshState(
             window,
            refreshStorageKeyRef.current,
            nextQueueIds,
            nextNewRequestIds,
          );
          setItems(nextItems);
          setLoadError(null);
        }
      } else if (mountedRef.current && fetchGeneration === fetchGenerationRef.current) {
        setLoadError("We couldn't load pending contractor emails. Please try again.");
      }
    } catch (e) {
      if (mountedRef.current && fetchGeneration === fetchGenerationRef.current) {
        setLoadError("We couldn't load pending contractor emails. Please try again.");
        console.error(e);
      }
    } finally {
      if (mountedRef.current && fetchGeneration === fetchGenerationRef.current) {
        setLoading(false);
      }
    }
  }

  const grouped = useMemo(() => {
    const filtered = items.filter(item => 
      (item.contractorName?.toLowerCase().includes(search.toLowerCase()) || '') ||
      (item.jobTitle?.toLowerCase().includes(search.toLowerCase()) || '') ||
      (item.siteName?.toLowerCase().includes(search.toLowerCase()) || '')
    );

    const map = new Map<string, EmailQueueItem[]>();
    for (const item of filtered) {
      const site = item.siteName || "No Site";
      if (!map.has(site)) map.set(site, []);
      map.get(site)!.push(item);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items, search]);

  useEffect(() => {
    if (grouped.length > 0 && expandedSites.size === 0) {
      setExpandedSites(new Set(grouped.map(g => g[0])));
    }
  }, [grouped]);

  function toggleSite(site: string) {
    const next = new Set(expandedSites);
    if (next.has(site)) next.delete(site);
    else next.add(site);
    setExpandedSites(next);
  }

  function markRequestReviewed(itemId: number) {
    const nextNewRequestIds = newRequestIdsRef.current.filter(id => id !== itemId);
    newRequestIdsRef.current = nextNewRequestIds;
    setNewRequestIds(nextNewRequestIds);
     persistApprovalRefreshState(
       window,
      refreshStorageKeyRef.current,
      knownQueueIdsRef.current,
      nextNewRequestIds,
    );
  }

  function markAllRequestsReviewed() {
    newRequestIdsRef.current = [];
    setNewRequestIds([]);
     persistApprovalRefreshState(
       window,
      refreshStorageKeyRef.current,
      knownQueueIdsRef.current,
      [],
    );
  }

  function handleApprove(item: EmailQueueItem, modifiedPreview?: { subject: string; text: string }) {
    markRequestReviewed(item.id);
    if (item.emailType === "cancellation") {
      setPendingCancellationConfirmation({ action: "approve", item, modifiedPreview });
      return;
    }
    void submitApproval(item, modifiedPreview);
  }

  async function submitApproval(
    item: EmailQueueItem,
    modifiedPreview?: { subject: string; text: string },
  ): Promise<boolean> {
    const isCancellation = item.emailType === "cancellation";
    setSubmittingId(item.id);
    try {
      const result = await approveContractorEmail(
        item,
        {
          confirm: message => (isCancellation ? true : window.confirm(message)),
          clientApiFetch,
        },
        modifiedPreview,
      );
      if (!result.confirmed) return false;
      if (!mountedRef.current) return false;
      toast({
        title: isCancellation ? "Calendar cancellation approved and sent" : "Email approved and sent",
      });
      setEditingId(null);
      setItems(prev => prev.filter(i => i.id !== item.id));
      return true;
    } catch (e: any) {
      if (mountedRef.current) {
        toast({ title: "Error", description: e.message, variant: "destructive" });
      }
      return false;
    } finally {
      if (mountedRef.current) setSubmittingId(null);
    }
  }

  function handleCancel(item: EmailQueueItem) {
    markRequestReviewed(item.id);
    if (item.emailType === "cancellation") {
      setPendingCancellationConfirmation({ action: "dismiss", item });
      return;
    }
    void submitDismissal(item);
  }

  async function submitDismissal(item: EmailQueueItem): Promise<boolean> {
    const isCancellation = item.emailType === "cancellation";
    setSubmittingId(item.id);
    try {
      const result = await dismissContractorEmail(
        item,
        {
          confirm: message => (isCancellation ? true : window.confirm(message)),
          clientApiFetch,
        },
      );
      if (!result.confirmed) return false;
      if (!mountedRef.current) return false;
      toast({ title: isCancellation ? "Calendar cancellation dismissed" : "Email cancelled" });
      setItems(prev => prev.filter(i => i.id !== item.id));
      return true;
    } catch (e: any) {
      if (mountedRef.current) {
        toast({ title: "Error", description: e.message, variant: "destructive" });
      }
      return false;
    } finally {
      if (mountedRef.current) setSubmittingId(null);
    }
  }

  function confirmCancellation(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const pending = pendingCancellationConfirmation;
    if (!pending || submittingId === pending.item.id) return;

    if (pending.action === "approve") {
      void submitApproval(pending.item, pending.modifiedPreview).then(success => {
        if (success && mountedRef.current) setPendingCancellationConfirmation(null);
      });
    } else {
      void submitDismissal(pending.item).then(success => {
        if (success && mountedRef.current) setPendingCancellationConfirmation(null);
      });
    }
  }

  function startEdit(item: EmailQueueItem) {
    markRequestReviewed(item.id);
    setEditingId(item.id);
    const p = item.emailPreviewJson || {};
    setEditSubject(p.subject || "");
    setEditText(p.text || "");
  }

  return (
    <AppLayout title="Contractor Approvals">
      <div className="max-w-5xl mx-auto py-6 px-4 space-y-6">
        <div className="flex flex-col sm:flex-row gap-4 sm:items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Contractor Email Approvals</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Review and approve outbound emails before they are sent to contractors.
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Button
              variant="outline"
              size="sm"
              onClick={fetchItems}
              disabled={loading}
              className="shrink-0"
            >
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {loading ? "Refreshing…" : "Refresh approvals"}
            </Button>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search emails..."
                className="pl-9 bg-background"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {newRequestIds.length > 0 && (
              <div className="mb-4 flex flex-col gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-blue-950">
                    {newRequestIds.length} new approval{" "}
                    {newRequestIds.length === 1 ? "request" : "requests"} found
                  </p>
                  <p className="text-xs text-blue-900/80">
                    Review the refreshed list to see the new work.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={markAllRequestsReviewed}
                >
                  Mark as reviewed
                </Button>
              </div>
            )}
            {loadError && (
              <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-amber-950">Approvals may be out of date</p>
                  <p className="text-xs text-amber-900/80">
                    {loadError} Showing the last successful approval list below.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={fetchItems} className="shrink-0">
                  Try again
                </Button>
              </div>
            )}
            {loading && items.length > 0 && (
              <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Refreshing approvals…
              </div>
            )}
            {items.length === 0 ? (
              loadError ? (
                <div className="text-center py-16 bg-card border rounded-lg">
                  <p className="text-sm font-medium text-foreground">Unable to load approvals</p>
                  <p className="text-xs text-muted-foreground mt-1">{loadError}</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={fetchItems}>
                    Try again
                  </Button>
                </div>
              ) : (
                <div className="text-center py-16 bg-card border rounded-lg text-muted-foreground">
                  <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="text-sm font-medium text-foreground">No pending emails</p>
                  <p className="text-xs mt-1">All contractor emails have been reviewed.</p>
                </div>
              )
            ) : (
              <div className="space-y-4">
                {grouped.map(([site, siteItems]) => (
                  <div key={site} className="border rounded-lg bg-card overflow-hidden">
                    <button
                      className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors"
                      onClick={() => toggleSite(site)}
                    >
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-muted-foreground" />
                        <span className="font-semibold">{site}</span>
                        <span className="text-xs px-2 py-0.5 bg-background border rounded-full text-muted-foreground ml-2 tabular-nums">
                          {siteItems.length}
                        </span>
                      </div>
                      {expandedSites.has(site) ? (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      )}
                    </button>

                    {expandedSites.has(site) && (
                      <div className="divide-y border-t">
                        {siteItems.map(item => {
                          const isEditing = editingId === item.id;
                           const isCancellation = item.emailType === "cancellation";
                          const isNewRequest = newRequestIds.includes(item.id);
                           const preview = item.emailPreviewJson || {};

                          return (
                            <div
                              key={item.id}
                              className={cn(
                                "p-4 flex flex-col gap-4",
                                isNewRequest && "bg-blue-50/40",
                              )}
                            >
                              <div className="flex items-start justify-between gap-4 flex-wrap">
                                <div>
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className={cn("text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border",
                                      isCancellation
                                        ? "bg-amber-50 text-amber-800 border-amber-300"
                                        : item.emailType === "quote_request"
                                          ? "bg-violet-50 text-violet-700 border-violet-200"
                                          : "bg-blue-50 text-blue-700 border-blue-200"
                                    )}>
                                      {isCancellation
                                        ? "Calendar Cancellation"
                                        : item.emailType === "quote_request"
                                          ? "Requesting Quote"
                                          : item.emailType === "reminder"
                                            ? "Reminder"
                                            : "Assigning Job"}
                                    </span>
                                    {isNewRequest && (
                                      <span
                                        className="rounded border border-blue-200 bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-800"
                                        aria-label="New approval request"
                                      >
                                        New
                                      </span>
                                    )}
                                    <span className="text-xs text-muted-foreground">
                                      {format(new Date(item.createdAt), "dd MMM, HH:mm")}
                                    </span>
                                  </div>
                                  <h3 className="font-medium">{item.jobTitle || "Untitled Job"}</h3>
                                  <div className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
                                    <Building className="w-3.5 h-3.5" />
                                    {item.contractorName || "Unknown Contractor"}
                                  </div>
                                  {item.requestedBy && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                      Requested by: {item.requestedBy}
                                    </p>
                                  )}
                                </div>

                                {!isEditing && (
                                  <div className="flex items-center gap-2 shrink-0">
                                    <Button
                                      variant="outline" size="sm"
                                       onClick={() => handleCancel(item)}
                                      disabled={submittingId === item.id}
                                      className="h-8"
                                    >
                                       {isCancellation ? "Dismiss" : "Cancel"}
                                    </Button>
                                    <Button
                                      variant="outline" size="sm"
                                      onClick={() => startEdit(item)}
                                      disabled={submittingId === item.id}
                                      className="h-8"
                                    >
                                      <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                                    </Button>
                                    <Button
                                      size="sm"
                                       onClick={() => handleApprove(item)}
                                      disabled={submittingId === item.id}
                                       className={cn(
                                         "h-8 text-white",
                                         isCancellation
                                           ? "bg-amber-600 hover:bg-amber-700"
                                           : "bg-blue-600 hover:bg-blue-700"
                                       )}
                                    >
                                       {submittingId === item.id
                                         ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                         : isCancellation
                                           ? <CalendarX2 className="w-3.5 h-3.5 mr-1" />
                                           : <Send className="w-3.5 h-3.5 mr-1" />}
                                       {isCancellation ? "Approve Cancellation" : "Approve & Send"}
                                    </Button>
                                  </div>
                                )}
                              </div>

                              <div className="bg-muted/30 border rounded-md p-3 text-sm font-mono whitespace-pre-wrap text-foreground/80">
                                {isEditing ? (
                                  <div className="space-y-3 font-sans">
                                     {isCancellation && (
                                       <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-950">
                                         <CalendarX2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                                         <div>
                                           <p className="font-semibold">This cancels an existing calendar event</p>
                                           <p className="mt-0.5 text-xs text-amber-900/80">
                                             Approving sends the contractor a cancellation notice and removes the previously sent assignment from their calendar.
                                           </p>
                                         </div>
                                       </div>
                                     )}
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Subject</label>
                                      <Input
                                        value={editSubject}
                                        onChange={e => setEditSubject(e.target.value)}
                                        className="h-8 font-mono text-sm"
                                      />
                                    </div>
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Body</label>
                                      <Textarea
                                        value={editText}
                                        onChange={e => setEditText(e.target.value)}
                                        className="min-h-[200px] font-mono text-sm"
                                      />
                                    </div>
                                    <div className="flex justify-end gap-2 pt-2">
                                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)} disabled={submittingId === item.id}>
                                        Cancel Edit
                                      </Button>
                                       <Button
                                         size="sm"
                                         className={isCancellation ? "bg-amber-600 hover:bg-amber-700" : "bg-blue-600 hover:bg-blue-700"}
                                         onClick={() => handleApprove(item, { subject: editSubject, text: editText })}
                                         disabled={submittingId === item.id}
                                       >
                                        {submittingId === item.id ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                                         {isCancellation ? "Save & Send Cancellation" : "Save & Send"}
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                     {isCancellation && (
                                       <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 font-sans text-amber-950">
                                         <CalendarX2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                                         <div>
                                           <p className="font-semibold">This cancels an existing calendar event</p>
                                           <p className="mt-0.5 text-xs text-amber-900/80">
                                             Approving sends the contractor a cancellation notice and removes the previously sent assignment from their calendar.
                                           </p>
                                         </div>
                                       </div>
                                     )}
                                    <div className="font-semibold text-foreground mb-2">Subject: {preview.subject}</div>
                                    {preview.text}
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <AlertDialog
        open={pendingCancellationConfirmation !== null}
        onOpenChange={open => {
          const isSubmittingCancellation =
            pendingCancellationConfirmation !== null &&
            submittingId === pendingCancellationConfirmation.item.id;
          if (!open && !isSubmittingCancellation) setPendingCancellationConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingCancellationConfirmation?.action === "approve"
                ? "Approve calendar cancellation?"
                : "Dismiss calendar cancellation?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCancellationConfirmation?.action === "approve"
                ? "This will send the contractor a cancellation notice and remove the previously sent calendar event."
                : "Nothing will be sent and the existing calendar event will remain in place."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                pendingCancellationConfirmation !== null &&
                submittingId === pendingCancellationConfirmation.item.id
              }
            >
              Keep reviewing
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={
                pendingCancellationConfirmation !== null &&
                submittingId === pendingCancellationConfirmation.item.id
              }
              className={
                pendingCancellationConfirmation?.action === "approve"
                  ? "bg-amber-600 text-white hover:bg-amber-700"
                  : "bg-muted text-foreground hover:bg-muted/80"
              }
              onClick={confirmCancellation}
            >
              {pendingCancellationConfirmation !== null &&
              submittingId === pendingCancellationConfirmation.item.id ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : pendingCancellationConfirmation?.action === "approve" ? (
                "Approve Cancellation"
              ) : (
                "Dismiss"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
