import { useEffect, useState } from "react";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import { AppLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { CertificateFormDialog } from "@/components/certificate-form-dialog";
import { CertificateReaderButton } from "@/components/certificate-reader-dialog";
import { StatusBadge, PriorityBadge, ExpiryBadge, NeedsActionBadge, needsActionLabel } from "@/components/badges";
import { CheckStatusWithCertificate } from "@/components/certificates-outstanding-card";
import { CompleteCheckDialog } from "@/components/complete-check-dialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetComplianceItem,
  getGetComplianceItemQueryKey,
  useListItemCertificates,
  getListItemCertificatesQueryKey,
  useListContractors,
  useListSites,
  useListCategories,
} from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { useAuth, useCanAdmin, useCanEdit } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { LoadError } from "@/components/load-error";
import { format } from "date-fns";
import {
  ArrowLeft, Pencil, Trash2, FileText, Plus, ExternalLink,
  Briefcase, MapPin, Calendar, Clock, ClipboardList, Mail, User, Repeat,
  CheckCircle2, ShieldAlert, Wrench,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function fmt(d: any) {
  if (!d) return "—";
  try { return format(new Date(d), "EEE, d MMM yyyy"); } catch { return "—"; }
}

type AuditEvent = {
  id: number;
  actorName: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

const CERTIFICATE_AUDIT: Record<string, string> = {
  certificate_added: "Added a certificate",
  certificate_updated: "Updated a certificate",
  certificate_deleted: "Deleted a certificate",
  certificate_defect_added: "Recorded a certificate defect",
  certificate_defect_resolved: "Marked a certificate defect remedied",
  certificate_defect_reopened: "Reopened a certificate defect",
  certificate_defect_deleted: "Removed a certificate defect",
};

const OUTCOME_LABELS: Record<string, { label: string; className: string }> = {
  satisfactory: { label: "Satisfactory", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  unsatisfactory: { label: "Unsatisfactory", className: "bg-rose-100 text-rose-800 border-rose-300" },
  not_stated: { label: "Outcome not stated", className: "bg-slate-100 text-slate-700 border-slate-200" },
};

function auditSummary(event: AuditEvent) {
  if (CERTIFICATE_AUDIT[event.action]) {
    const name = (event.after?.name ?? event.before?.name) as string | undefined;
    return name ? `${CERTIFICATE_AUDIT[event.action]}: ${name}` : CERTIFICATE_AUDIT[event.action];
  }
  if (event.action === "created") return "Created this compliance check";
  if (event.action === "deleted") return "Deleted this compliance check";
  const beforeStatus = event.before?.status;
  const afterStatus = event.after?.status;
  if (event.action === "status_changed" || beforeStatus !== afterStatus) {
    return `Changed status from ${String(beforeStatus ?? "unset").replace("_", " ")} to ${String(afterStatus ?? "unset").replace("_", " ")}`;
  }
  return "Updated this compliance check";
}

export default function ItemDetailPage() {
  const [, params] = useRoute("/items/:id");
  const id = params ? Number(params.id) : NaN;

  const { data: item, isLoading, error: itemError, refetch: refetchItem } = useGetComplianceItem(id, { query: { enabled: Number.isFinite(id), queryKey: getGetComplianceItemQueryKey(id) } });
  const { data: certificates = [] } = useListItemCertificates(id, { query: { enabled: Number.isFinite(id), queryKey: getListItemCertificatesQueryKey(id) } });
  const { data: contractors = [] } = useListContractors();
  const { data: sites = [] } = useListSites();
  const { data: categories = [] } = useListCategories();

  const { deleteItem, deleteItemCertificate } = useAppMutations();
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const canEdit = useCanEdit();
  const queryClient = useQueryClient();
  const search = useSearch();
  const [, navigate] = useLocation();
  const [completeOpen, setCompleteOpen] = useState(false);
  const [certIssueDate, setCertIssueDate] = useState<string | null>(null);
  const [defectBusy, setDefectBusy] = useState<number | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [certOpen, setCertOpen] = useState(false);
  const [editingCert, setEditingCert] = useState<any>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditError, setAuditError] = useState(false);

  // "Done + add certificate" from the checks list lands here with
  // ?certificate=new&issued=YYYY-MM-DD: open the upload form once.
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("certificate") !== "new" || !canAdmin) return;
    const issued = params.get("issued");
    setEditingCert(null);
    setCertIssueDate(issued && /^\d{4}-\d{2}-\d{2}$/.test(issued) ? issued : null);
    setCertOpen(true);
    navigate(`/items/${id}`, { replace: true });
  }, [search, canAdmin, id, navigate]);

  const markDefectRemedied = async (certificateId: number, defectId: number, resolved: boolean) => {
    setDefectBusy(defectId);
    try {
      const clientQuery = activeClientId ? `?clientId=${activeClientId}` : "";
      const res = await apiFetch(`/items/${id}/certificates/${certificateId}/defects/${defectId}${clientQuery}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved }),
      });
      if (!res.ok) throw new Error("Could not update the defect");
      await queryClient.invalidateQueries({ queryKey: getListItemCertificatesQueryKey(id) });
      await queryClient.invalidateQueries({ queryKey: getGetComplianceItemQueryKey(id) });
    } catch {
      /* the list keeps the last known state */
    } finally {
      setDefectBusy(null);
    }
  };

  useEffect(() => {
    // Clear a prior item's entries immediately when a route or consultant
    // tenant context changes, rather than briefly rendering stale evidence.
    setAuditEvents([]);
    setAuditError(false);
    if (!canAdmin || !Number.isFinite(id)) return;
    let cancelled = false;
    const clientQuery = activeClientId ? `&clientId=${activeClientId}` : "";
    void apiFetch(`/audit-events?entityType=compliance_item&entityId=${id}${clientQuery}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load audit history");
        return response.json() as Promise<AuditEvent[]>;
      })
      .then((events) => { if (!cancelled) setAuditEvents(events); })
      .catch(() => { if (!cancelled) setAuditError(true); });
    return () => { cancelled = true; };
  }, [activeClientId, canAdmin, id]);

  if (isLoading) {
    return <AppLayout title="Compliance Check"><div className="py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div></AppLayout>;
  }
  // Only a 404 means the check does not exist; anything else is a failed load.
  if (!item && itemError && (itemError as { status?: number }).status !== 404) {
    return <AppLayout title="Compliance Check"><div className="py-12"><LoadError message="This compliance check could not be loaded." onRetry={() => void refetchItem()} /></div></AppLayout>;
  }
  if (!item) {
    return <AppLayout title="Not Found"><div className="py-12 text-center text-muted-foreground">Compliance check not found.</div></AppLayout>;
  }

  const contractor = contractors.find(c => c.id === item.contractorId);
  const site = sites.find(s => s.id === item.siteId);
  const category = categories.find(c => c.id === item.categoryId);

  return (
    <AppLayout title={item.title}>
      <div className="mb-4">
        <Link href="/external-checks" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Compliance Checks
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="p-6 shadow-lg border-border/50">
            <div className="flex items-start justify-between gap-4 mb-5">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {category && (
                    <span className="text-xs px-2 py-0.5 rounded-md text-white font-medium" style={{ backgroundColor: category.color ?? "#6366f1" }}>
                      {category.name}
                    </span>
                  )}
                  <CheckStatusWithCertificate item={item}>
                    <StatusBadge status={item.status} />
                  </CheckStatusWithCertificate>
                  <NeedsActionBadge item={item} />
                  <PriorityBadge priority={item.priority} />
                </div>
                <h1 className="font-display font-bold text-2xl">{item.title}</h1>
                {item.description && (
                  <p className="text-muted-foreground mt-2 whitespace-pre-line">{item.description}</p>
                )}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                {canEdit && (
                  <Button variant="outline" size="sm" onClick={() => setCompleteOpen(true)} title="Mark as done">
                    <CheckCircle2 className="w-4 h-4 mr-1.5 text-emerald-600" /> Mark done
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={() => setEditOpen(true)} title="Edit">
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleteConfirm(true)} title="Delete">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {item.needsAction && (
              <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
                <ShieldAlert className="w-5 h-5 mt-0.5 shrink-0 text-rose-600" />
                <div>
                  <p className="font-semibold">{needsActionLabel(item)}</p>
                  <p className="mt-0.5">
                    {item.needsActionReason === "certificate_outstanding"
                      ? "The contractor has been but no certificate has been uploaded. The check counts as not compliant until it is: add the certificate below when it arrives."
                      : (item.openDefectCount ?? 0) > 0
                      ? "This check needs action until the FixTrack jobs for its C1/C2/FI (or gas ID/AR) defects are resolved, or a new satisfactory certificate is added."
                      : "The latest certificate is unsatisfactory. Add its defects so the remedial work is tracked, or add a new satisfactory certificate once the work is done."}
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-x-6 gap-y-4 pt-4 border-t border-border/50">
              <div className="flex items-start gap-3">
                <Calendar className="w-4 h-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Due Date</p>
                  <p className="text-sm font-medium">{item.dueDate ? fmt(item.dueDate) : "Not set — enter it from your last service date"}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Repeat className="w-4 h-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Repeats</p>
                  <p className="text-sm font-medium">
                    {item.frequencyMonths
                      ? `Every ${item.frequencyMonths} month${item.frequencyMonths === 1 ? "" : "s"}`
                      : "One-off"}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Clock className="w-4 h-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Reminder Lead Time</p>
                  <p className="text-sm font-medium">{item.leadTimeDays ? `${item.leadTimeDays} day${item.leadTimeDays === 1 ? "" : "s"} before` : "—"}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Briefcase className="w-4 h-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Contractor</p>
                  {contractor ? (
                    <Link href={`/contractors/${contractor.id}`} className="text-sm font-medium text-primary hover:underline">
                      {contractor.name}{contractor.company ? ` — ${contractor.company}` : ""}
                    </Link>
                  ) : <p className="text-sm text-muted-foreground italic">Unassigned</p>}
                  {contractor?.email && (
                    <p className="text-xs text-muted-foreground flex items-center mt-0.5"><Mail className="w-3 h-3 mr-1" />{contractor.email}</p>
                  )}
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="w-4 h-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Site</p>
                  <p className="text-sm font-medium">{site?.name ?? "—"}</p>
                </div>
              </div>
              {item.assignedTo && (
                <div className="flex items-start gap-3">
                  <User className="w-4 h-4 mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Assigned To</p>
                    <p className="text-sm font-medium">{item.assignedTo}</p>
                  </div>
                </div>
              )}
              {(item as any).visitScheduledAt && (
                <div className="flex items-start gap-3">
                  <Calendar className="w-4 h-4 mt-0.5 text-emerald-600" />
                  <div>
                    <p className="text-xs uppercase tracking-wider text-emerald-700 font-semibold">Visit Scheduled</p>
                    <p className="text-sm font-medium">{fmt((item as any).visitScheduledAt)}</p>
                  </div>
                </div>
              )}
            </div>

            {item.notes && (
              <div className="mt-6 pt-4 border-t border-border/50">
                <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2 flex items-center gap-1.5">
                  <ClipboardList className="w-3.5 h-3.5" /> Notes
                </p>
                <p className="text-sm whitespace-pre-line">{item.notes}</p>
              </div>
            )}
          </Card>

          {/* Certificates section — now lives on the check itself */}
          <Card className="shadow-lg border-border/50 overflow-hidden">
            <div className="p-6 bg-muted/20 border-b border-border/50 flex justify-between items-center">
              <div>
                <h3 className="font-display text-lg font-bold flex items-center gap-2">
                  <FileText className="w-5 h-5 text-primary" /> Certificates
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Documentation for this compliance check — upload the certificate that proves this requirement.
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {canAdmin && <CertificateReaderButton itemId={item.id} size="sm" label="Read with AI" className="shadow-sm" />}
                <Button size="sm" onClick={() => { setEditingCert(null); setCertIssueDate(null); setCertOpen(true); }} className="shadow-sm">
                  <Plus className="w-4 h-4 mr-1.5" /> Upload
                </Button>
              </div>
            </div>
            {certificates.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <FileText className="w-8 h-8 mx-auto mb-3 opacity-20" />
                <p>No certificates uploaded yet.</p>
                <p className="text-xs mt-1">
                  Your upload will be labelled as a {item.title} certificate by default.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {certificates.map(cert => (
                  <div key={cert.id} className="p-4 hover:bg-muted/30 transition-colors flex justify-between items-center group">
                    <div className="min-w-0">
                      <h4 className="font-bold truncate">{cert.name}</h4>
                      <div className="flex flex-wrap gap-3 mt-1.5 text-sm">
                        {cert.outcome && OUTCOME_LABELS[cert.outcome] && (
                          <Badge variant="outline" className={OUTCOME_LABELS[cert.outcome].className}>{OUTCOME_LABELS[cert.outcome].label}</Badge>
                        )}
                        <ExpiryBadge expiryDate={cert.expiryDate} />
                        {cert.issueDate && <span className="text-muted-foreground">Issued: {format(new Date(cert.issueDate), "d MMM yyyy")}</span>}
                      </div>
                      {cert.notes && <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{cert.notes}</p>}
                      {(cert.defects ?? []).length > 0 && (
                        <ul className="mt-2 space-y-1.5">
                          {(cert.defects ?? []).map((d) => (
                            <li key={d.id} className={`flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${d.open && d.blocking ? "border-rose-300 bg-rose-50 dark:bg-rose-950/30" : "bg-muted/30"}`}>
                              <span className={`font-bold ${d.open && d.blocking ? "text-rose-700" : ""}`}>{d.code}</span>
                              <span className="min-w-0">{d.description}{d.location ? <span className="text-muted-foreground"> · {d.location}</span> : null}</span>
                              {d.fixTrackIssueId ? (
                                <Link href={`/fix-track/${d.fixTrackIssueId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                                  <Wrench className="w-3 h-3" /> FixTrack #{d.fixTrackIssueId}
                                  {d.fixTrackStatus ? ` (${d.fixTrackStatus.replace("_", " ")})` : ""}
                                </Link>
                              ) : d.resolvedAt ? (
                                <span className="text-emerald-700">Remedied</span>
                              ) : (
                                <span className="text-muted-foreground">No FixTrack job</span>
                              )}
                              {canAdmin && !d.fixTrackIssueId && (
                                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={defectBusy === d.id}
                                  onClick={() => void markDefectRemedied(cert.id, d.id, !d.resolvedAt)}>
                                  {d.resolvedAt ? "Reopen" : "Mark remedied"}
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      {cert.fileUrl && (
                        <Button variant="outline" size="sm" asChild className="h-8 bg-background">
                          <a href={`/api/storage${cert.fileUrl}`} target="_blank" rel="noreferrer">
                            <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> View
                          </a>
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditingCert(cert); setCertIssueDate(null); setCertOpen(true); }}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deleteItemCertificate.mutate({ itemId: id, id: cert.id })}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Card className="p-5 bg-card/60 backdrop-blur-md shadow-lg border-border/50">
            <h3 className="font-display text-sm font-bold mb-4 text-muted-foreground uppercase tracking-wider">Activity</h3>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Created</p>
                <p className="font-medium">{fmt(item.createdAt)}</p>
              </div>
              {item.dueDate && (
                <div>
                  <p className="text-xs text-muted-foreground">Due Date</p>
                  <p className="font-medium">{fmt(item.dueDate)}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">Last Updated</p>
                <p className="font-medium">{fmt(item.updatedAt)}</p>
              </div>
              {item.notificationSentAt && (
                <div>
                  <p className="text-xs text-muted-foreground">Last Reminder Sent</p>
                  <p className="font-medium">{fmt(item.notificationSentAt)}</p>
                </div>
              )}
              {item.completedAt && (
                <div>
                  <p className="text-xs text-emerald-700">{item.status === "completed" ? "Completed" : "Last completed"}</p>
                  <p className="font-medium">{fmt(item.completedAt)}</p>
                  {item.completedInHouseBy && (
                    <p className="text-xs text-muted-foreground" data-testid="completed-in-house-by">Done in house by {item.completedInHouseBy}</p>
                  )}
                </div>
              )}
            </div>
          </Card>
           {canAdmin && (
             <Card className="p-5 bg-card/60 backdrop-blur-md shadow-lg border-border/50">
               <h3 className="font-display text-sm font-bold mb-4 text-muted-foreground uppercase tracking-wider">Inspection audit trail</h3>
               {auditError ? (
                 <p className="text-sm text-muted-foreground">Audit history could not be loaded.</p>
               ) : auditEvents.length === 0 ? (
                 <p className="text-sm text-muted-foreground">No recorded changes yet.</p>
               ) : (
                 <ol className="space-y-4">
                   {auditEvents.map((event) => (
                     <li key={event.id} className="border-l-2 border-primary/30 pl-3">
                       <p className="text-sm font-medium">{auditSummary(event)}</p>
                       <p className="mt-1 text-xs text-muted-foreground">
                         {event.actorName ?? "Former user"} · {fmt(event.createdAt)}
                       </p>
                     </li>
                   ))}
                 </ol>
               )}
             </Card>
           )}
        </div>
      </div>

      <ItemFormDialog isOpen={editOpen} onClose={() => setEditOpen(false)} item={item as any} />
      <CertificateFormDialog
        isOpen={certOpen}
        onClose={() => setCertOpen(false)}
        itemId={id}
        suggestedName={item.title}
        defaultIssueDate={certIssueDate}
        certificate={editingCert}
      />
      <CompleteCheckDialog
        item={completeOpen ? item : null}
        onClose={() => setCompleteOpen(false)}
        onAddCertificate={canAdmin ? (date) => { setEditingCert(null); setCertIssueDate(date); setCertOpen(true); } : undefined}
      />

      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Compliance Check?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{item.title}" and any certificates uploaded against it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                try {
                  await deleteItem.mutateAsync({ id });
                  window.location.href = "/external-checks";
                } catch {
                  /* mutation hook surfaces toast on error */
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
