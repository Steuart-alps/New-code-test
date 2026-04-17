import { useState } from "react";
import { Link, useRoute } from "wouter";
import { AppLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { CertificateFormDialog } from "@/components/certificate-form-dialog";
import { StatusBadge, PriorityBadge, ExpiryBadge } from "@/components/badges";
import {
  useGetComplianceItem,
  useListItemCertificates,
  useListContractors,
  useListSites,
  useListCategories,
} from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { format } from "date-fns";
import {
  ArrowLeft, Pencil, Trash2, FileText, Plus, ExternalLink,
  Briefcase, MapPin, Calendar, Clock, ClipboardList, Mail, User,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function fmt(d: any) {
  if (!d) return "—";
  try { return format(new Date(d), "EEE, d MMM yyyy"); } catch { return "—"; }
}

export default function ItemDetailPage() {
  const [, params] = useRoute("/items/:id");
  const id = params ? Number(params.id) : NaN;

  const { data: item, isLoading } = useGetComplianceItem(id, { query: { enabled: Number.isFinite(id) } });
  const { data: certificates = [] } = useListItemCertificates(id, { query: { enabled: Number.isFinite(id) } });
  const { data: contractors = [] } = useListContractors();
  const { data: sites = [] } = useListSites();
  const { data: categories = [] } = useListCategories();

  const { deleteItem, deleteItemCertificate } = useAppMutations();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [certOpen, setCertOpen] = useState(false);
  const [editingCert, setEditingCert] = useState<any>(null);

  if (isLoading) {
    return <AppLayout title="Compliance Check"><div className="py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div></AppLayout>;
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
                  <StatusBadge status={item.status} />
                  <PriorityBadge priority={item.priority} />
                </div>
                <h1 className="font-display font-bold text-2xl">{item.title}</h1>
                {item.description && (
                  <p className="text-muted-foreground mt-2 whitespace-pre-line">{item.description}</p>
                )}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <Button variant="ghost" size="icon" onClick={() => setEditOpen(true)} title="Edit">
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleteConfirm(true)} title="Delete">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-4 pt-4 border-t border-border/50">
              <div className="flex items-start gap-3">
                <Calendar className="w-4 h-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Due Date</p>
                  <p className="text-sm font-medium">{fmt(item.dueDate)}</p>
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
              {item.visitScheduledAt && (
                <div className="flex items-start gap-3">
                  <Calendar className="w-4 h-4 mt-0.5 text-emerald-600" />
                  <div>
                    <p className="text-xs uppercase tracking-wider text-emerald-700 font-semibold">Visit Scheduled</p>
                    <p className="text-sm font-medium">{fmt(item.visitScheduledAt)}</p>
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
                <p className="text-sm text-muted-foreground mt-1">Documentation for this compliance check</p>
              </div>
              <Button size="sm" onClick={() => { setEditingCert(null); setCertOpen(true); }} className="shadow-sm">
                <Plus className="w-4 h-4 mr-1.5" /> Upload
              </Button>
            </div>
            {certificates.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <FileText className="w-8 h-8 mx-auto mb-3 opacity-20" />
                No certificates uploaded yet.
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {certificates.map(cert => (
                  <div key={cert.id} className="p-4 hover:bg-muted/30 transition-colors flex justify-between items-center group">
                    <div className="min-w-0">
                      <h4 className="font-semibold truncate">{cert.name}</h4>
                      <div className="flex flex-wrap gap-3 mt-1.5 text-sm">
                        <ExpiryBadge expiryDate={cert.expiryDate} />
                        {cert.issueDate && <span className="text-muted-foreground">Issued: {format(new Date(cert.issueDate), "MMM d, yyyy")}</span>}
                      </div>
                      {cert.notes && <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{cert.notes}</p>}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      {cert.fileUrl && (
                        <Button variant="outline" size="sm" asChild className="h-8 bg-background">
                          <a href={`/api/storage${cert.fileUrl}`} target="_blank" rel="noreferrer">
                            <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> View
                          </a>
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditingCert(cert); setCertOpen(true); }}>
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
                  <p className="text-xs text-emerald-700">Completed</p>
                  <p className="font-medium">{fmt(item.completedAt)}</p>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <ItemFormDialog isOpen={editOpen} onClose={() => setEditOpen(false)} item={item as any} />
      <CertificateFormDialog isOpen={certOpen} onClose={() => setCertOpen(false)} itemId={id} certificate={editingCert} />

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
