import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import {
  useListComplianceItems,
  useSendReminderForItem
} from "@workspace/api-client-react";
import { toast } from "sonner";
import { useAppMutations } from "@/hooks/use-app-data";
import { ContractorFormDialog } from "@/components/contractor-form-dialog";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge, PriorityBadge, LiabilityBadge, DbsReviewBadge } from "@/components/badges";
import { ExpiryBadge } from "@/components/badges";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useAuth } from "@/context/auth-context";
import { format } from "date-fns";
import {
  Building, Mail, Phone, MapPin, Pencil, Trash2, ArrowLeft, Send,
  Plus, ShieldCheck, Flame, ShieldCheck as ShieldIcon, FileBadge,
  Award, ShieldAlert, X
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// ── Certificate presets ────────────────────────────────────────────────────
const CERT_PRESETS = [
  "IPAF (Powered Access)",
  "PASMA (Mobile Access Towers)",
  "CSCS Card",
  "First Aid at Work",
  "Emergency First Aid at Work",
  "Asbestos Awareness",
  "COSHH Awareness",
  "Manual Handling",
  "Working at Height",
  "Confined Space",
  "Gas Safe Registration",
  "NICEIC / Part P Electrical",
  "Chainsaw (NPTC CS30)",
  "Chainsaw (NPTC CS31)",
  "Chainsaw (NPTC CS32)",
  "Chainsaw (NPTC CS38)",
  "Food Hygiene (Level 2)",
  "Food Hygiene (Level 3)",
  "DBS Check (Basic)",
  "DBS Check (Standard)",
  "DBS Check (Enhanced)",
  "PVG Scheme (Scotland)",
  "Other",
] as const;

const CERT_EXPIRY_YEARS: Record<string, number> = {
  "IPAF (Powered Access)": 5,
  "PASMA (Mobile Access Towers)": 5,
  "First Aid at Work": 3,
  "Emergency First Aid at Work": 3,
  "Asbestos Awareness": 1,
  "COSHH Awareness": 3,
  "Manual Handling": 3,
  "Chainsaw (NPTC CS30)": 5,
  "Chainsaw (NPTC CS31)": 5,
  "Chainsaw (NPTC CS32)": 5,
  "Chainsaw (NPTC CS38)": 5,
  "Food Hygiene (Level 2)": 3,
  "Food Hygiene (Level 3)": 3,
  "DBS Check (Basic)": 3,
  "DBS Check (Standard)": 3,
  "DBS Check (Enhanced)": 3,
  "PVG Scheme (Scotland)": 5,
};

function suggestCertExpiry(name: string, completedDate: string): string {
  const years = CERT_EXPIRY_YEARS[name];
  if (!years || !completedDate) return "";
  const d = new Date(completedDate);
  if (isNaN(d.getTime())) return "";
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function toDateInput(v: unknown): string {
  if (!v) return "";
  const d = new Date(v as string);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

// ── Types ─────────────────────────────────────────────────────────────────

interface ContractorCert {
  id: number;
  certificate_name: string;
  issuer: string | null;
  completed_date: string | null;
  expiry_date: string | null;
  notes: string | null;
}

const emptyCertForm = () => ({
  certificateName: "", customName: "", issuer: "", completedDate: "", expiryDate: "", notes: "",
});

// ── Main page ─────────────────────────────────────────────────────────────

export default function ContractorDetailPage() {
  const params = useParams();
  const id = parseInt(params.id || "0");
  const qc = useQueryClient();
  const { activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();

  const [, navigate] = useLocation();
  const { data: contractor, isLoading: loadingContractor } = useQuery<any>({
    queryKey: ["contractor", id, activeClientId],
    queryFn: async () => {
      const response = await clientApiFetch(`/contractors/${id}`);
      if (!response.ok) throw new Error("Failed to load contractor");
      return response.json();
    },
    enabled: !!id && !!activeClientId,
  });
  const { data: items = [] } = useListComplianceItems({ contractorId: id });

  // Certificates
  const { data: certs = [], isLoading: loadingCerts } = useQuery<ContractorCert[]>({
    queryKey: ["contractor-certs", id, activeClientId],
    queryFn: async () => {
      const res = await clientApiFetch(`/contractors/${id}/certificates`);
      if (!res.ok) throw new Error("Failed to load certificates");
      return res.json();
    },
    enabled: !!id && !!activeClientId,
  });

  const { deleteItem } = useAppMutations();
  const deleteContractor = useMutation({
    mutationFn: async () => {
      const response = await clientApiFetch(`/contractors/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete contractor");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractors"] });
      navigate("/contractors");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const sendReminder = useSendReminderForItem({
    mutation: {
      onSuccess: (data: any) => toast.success(data?.message ?? "Reminder sent"),
      onError: (err: any) => toast.error(err?.message ?? "Failed to send reminder"),
    },
  });

  const [isEditContractorOpen, setIsEditContractorOpen] = useState(false);
  const [deleteContractorConfirm, setDeleteContractorConfirm] = useState(false);
  const [itemFormOpen, setItemFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);

  // Certificate dialog state
  const [certDialogOpen, setCertDialogOpen] = useState(false);
  const [editingCert, setEditingCert] = useState<ContractorCert | null>(null);
  const [certForm, setCertForm] = useState(emptyCertForm());
  const [certSaving, setCertSaving] = useState(false);
  const [deleteCertId, setDeleteCertId] = useState<number | null>(null);

  function openAddCert() {
    setEditingCert(null);
    setCertForm(emptyCertForm());
    setCertDialogOpen(true);
  }

  function openEditCert(cert: ContractorCert) {
    setEditingCert(cert);
    setCertForm({
      certificateName: CERT_PRESETS.includes(cert.certificate_name as any) ? cert.certificate_name : "Other",
      customName: CERT_PRESETS.includes(cert.certificate_name as any) ? "" : cert.certificate_name,
      issuer: cert.issuer ?? "",
      completedDate: toDateInput(cert.completed_date),
      expiryDate: toDateInput(cert.expiry_date),
      notes: cert.notes ?? "",
    });
    setCertDialogOpen(true);
  }

  const saveCert = useMutation({
    mutationFn: async () => {
      const name = certForm.certificateName === "Other" && certForm.customName.trim()
        ? certForm.customName.trim()
        : certForm.certificateName;
      if (!name) throw new Error("Certificate name is required");
      const payload = {
        certificateName: name,
        issuer: certForm.issuer || null,
        completedDate: certForm.completedDate || null,
        expiryDate: certForm.expiryDate || null,
        notes: certForm.notes || null,
      };
      const url = editingCert
        ? `/contractors/${id}/certificates/${editingCert.id}`
        : `/contractors/${id}/certificates`;
      const res = await clientApiFetch(url, {
        method: editingCert ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractor-certs", id] });
      setCertDialogOpen(false);
      toast.success(editingCert ? "Certificate updated" : "Certificate added");
    },
    onError: (err: any) => toast.error(err.message ?? "Save failed"),
  });

  const deleteCert = useMutation({
    mutationFn: async (certId: number) => {
      const res = await clientApiFetch(`/contractors/${id}/certificates/${certId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractor-certs", id] });
      setDeleteCertId(null);
      toast.success("Certificate removed");
    },
    onError: (err: any) => toast.error(err.message ?? "Delete failed"),
  });

  if (loadingContractor) return (
    <AppLayout title="Contractor Detail">
      <div className="animate-spin w-8 h-8 mx-auto mt-20 border-2 border-primary border-t-transparent rounded-full" />
    </AppLayout>
  );
  if (!contractor) return <AppLayout title="Not Found"><div>Contractor not found</div></AppLayout>;

  const c = contractor as any;

  return (
    <AppLayout title="Contractor Profile">
      <div className="mb-6">
        <Link href="/contractors" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Contractors
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-6">
          <Card className="p-6 bg-card/60 backdrop-blur-md shadow-lg border-border/50">
            <div className="flex justify-between items-start mb-6">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/60 text-primary-foreground flex items-center justify-center text-2xl font-bold shadow-lg shadow-primary/20">
                {contractor.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="icon" onClick={() => setIsEditContractorOpen(true)}>
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" onClick={() => setDeleteContractorConfirm(true)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <h2 className="text-2xl font-display font-bold">{contractor.name}</h2>
            {contractor.company && (
              <div className="flex items-center mt-2 text-muted-foreground">
                <Building className="w-4 h-4 mr-2" />
                <span className="font-medium">{contractor.company}</span>
              </div>
            )}

            {/* Contact */}
            <div className="mt-6 space-y-4 pt-6 border-t border-border/50">
              <div className="flex items-start">
                <Mail className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Email</p>
                  <p className="text-sm font-medium">{contractor.email}</p>
                </div>
              </div>
              {contractor.phone && (
                <div className="flex items-start">
                  <Phone className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Phone</p>
                    <p className="text-sm font-medium">{contractor.phone}</p>
                  </div>
                </div>
              )}
              {contractor.address && (
                <div className="flex items-start">
                  <MapPin className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Address</p>
                    <p className="text-sm font-medium">{contractor.address}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Compliance */}
            <div className="mt-6 space-y-4 pt-6 border-t border-border/50">
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Compliance</p>

              <div className="flex flex-wrap gap-1.5 empty:hidden">
                <LiabilityBadge expiry={contractor.publicLiabilityExpiry} />
                <LiabilityBadge expiry={c.dbsExpiryDate} label={c.dbsType ?? "DBS/PVG"} />
              </div>

              <div className="flex items-start">
                <Flame className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Gas Safe No.</p>
                  <p className="text-sm font-medium">{contractor.gasSafeNumber || "—"}</p>
                </div>
              </div>

              <div className="flex items-start">
                <FileBadge className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Insurance Renewal</p>
                  <p className="text-sm font-medium">
                    {contractor.publicLiabilityExpiry
                      ? format(new Date(contractor.publicLiabilityExpiry), "d MMM yyyy")
                      : "—"}
                  </p>
                </div>
              </div>

              <div className="flex items-start">
                <ShieldIcon className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">DBS / PVG</p>
                  <p className="text-sm font-medium">{c.dbsType || "—"}</p>
                  {c.dbsExpiryDate && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Expires {format(new Date(c.dbsExpiryDate), "d MMM yyyy")}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Main content */}
        <div className="lg:col-span-2 space-y-6">

          {/* Certificates card */}
          <Card className="shadow-lg border-border/50 overflow-hidden">
            <div className="p-6 bg-muted/20 border-b border-border/50 flex justify-between items-center">
              <div>
                <h3 className="font-display text-lg font-bold flex items-center gap-2">
                  <Award className="w-5 h-5 text-amber-500" /> Certificates &amp; Licences
                </h3>
                <p className="text-sm text-muted-foreground mt-1">Time-limited certificates held by this contractor</p>
              </div>
              <Button size="sm" onClick={openAddCert} className="shadow-sm">
                <Plus className="w-4 h-4 mr-1.5" /> Add Certificate
              </Button>
            </div>
            <div>
              {loadingCerts ? (
                <div className="p-6 text-center text-muted-foreground text-sm">Loading…</div>
              ) : certs.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">No certificates on record.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/40 bg-muted/10">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Certificate</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground hidden sm:table-cell">Issuer</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Expires</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {certs.map(cert => (
                      <tr key={cert.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3 font-medium">{cert.certificate_name}</td>
                        <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{cert.issuer || "—"}</td>
                        <td className="px-4 py-3">
                          {cert.expiry_date
                            ? <ExpiryBadge expiryDate={cert.expiry_date} />
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => openEditCert(cert)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteCertId(cert.id)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          {/* Compliance checks */}
          <Card className="shadow-lg border-border/50 overflow-hidden">
            <div className="p-6 bg-muted/20 border-b border-border/50 flex justify-between items-center">
              <div>
                <h3 className="font-display text-lg font-bold flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-emerald-500" /> Compliance Checks
                </h3>
                <p className="text-sm text-muted-foreground mt-1">External requirements assigned to this contractor</p>
              </div>
              <Button size="sm" onClick={() => { setEditingItem(null); setItemFormOpen(true); }} className="shadow-sm">
                <Plus className="w-4 h-4 mr-1.5" /> Add Requirement
              </Button>
            </div>
            <div>
              {items.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">No compliance requirements assigned.</div>
              ) : (
                <div className="divide-y divide-border/50">
                  {items.map(item => (
                    <div
                      key={item.id}
                      role="link"
                      tabIndex={0}
                      aria-label={`View details for ${item.title}`}
                      className="p-4 hover:bg-muted/30 transition-colors flex justify-between items-center group cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                      onClick={() => navigate(`/items/${item.id}`)}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(`/items/${item.id}`); } }}
                    >
                      <div>
                        <h4 className="font-semibold hover:text-primary transition-colors">{item.title}</h4>
                        <div className="flex items-center gap-3 mt-2 text-sm">
                          <StatusBadge status={item.status} />
                          <PriorityBadge priority={item.priority} />
                          {item.dueDate && (
                            <span className="text-muted-foreground">Due: {format(new Date(item.dueDate), "d MMM yyyy")}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                        {item.dueDate && contractor.email && (
                          <Button variant="ghost" size="icon" title="Resend reminder" disabled={sendReminder.isPending}
                            onClick={() => sendReminder.mutate({ itemId: item.id })}>
                            <Send className="w-4 h-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={() => { setEditingItem(item); setItemFormOpen(true); }}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="text-destructive"
                          onClick={() => deleteItem.mutate({ id: item.id })}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Certificate add/edit dialog */}
      <Dialog open={certDialogOpen} onOpenChange={setCertDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCert ? "Edit Certificate" : "Add Certificate"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Certificate / Licence *</Label>
              <Select value={certForm.certificateName}
                onValueChange={v => setCertForm(f => {
                  const suggested = suggestCertExpiry(v, f.completedDate);
                  return { ...f, certificateName: v, customName: "", expiryDate: f.expiryDate || suggested };
                })}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {CERT_PRESETS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
              {certForm.certificateName === "Other" && (
                <Input placeholder="Certificate name…" value={certForm.customName}
                  onChange={e => setCertForm(f => ({ ...f, customName: e.target.value }))}
                  className="mt-2 rounded-sm" />
              )}
            </div>
            <div>
              <Label>Issuing Body</Label>
              <Input placeholder="e.g. IPAF, PASMA, St John Ambulance…" value={certForm.issuer}
                onChange={e => setCertForm(f => ({ ...f, issuer: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Completed</Label>
                <Input type="date" value={certForm.completedDate}
                  onChange={e => {
                    const completedDate = e.target.value;
                    setCertForm(f => {
                      const suggested = suggestCertExpiry(f.certificateName, completedDate);
                      return { ...f, completedDate, expiryDate: f.expiryDate || suggested };
                    });
                  }}
                  className="mt-1 rounded-sm" />
              </div>
              <div>
                <Label>Expires</Label>
                <Input type="date" value={certForm.expiryDate}
                  onChange={e => setCertForm(f => ({ ...f, expiryDate: e.target.value }))}
                  className="mt-1 rounded-sm" />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea placeholder="Certificate number, renewal notes…" value={certForm.notes}
                onChange={e => setCertForm(f => ({ ...f, notes: e.target.value }))}
                className="mt-1 rounded-sm" rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCertDialogOpen(false)}>Cancel</Button>
            <Button disabled={saveCert.isPending} onClick={() => saveCert.mutate()}>
              {saveCert.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete certificate confirm */}
      <AlertDialog open={deleteCertId !== null} onOpenChange={() => setDeleteCertId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Certificate?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete the certificate record.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground"
              onClick={() => deleteCertId && deleteCert.mutate(deleteCertId)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ContractorFormDialog isOpen={isEditContractorOpen} onClose={() => setIsEditContractorOpen(false)} contractor={contractor} />
      <ItemFormDialog isOpen={itemFormOpen} onClose={() => setItemFormOpen(false)} item={editingItem} />

      <AlertDialog open={deleteContractorConfirm} onOpenChange={setDeleteContractorConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contractor?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {contractor.name}. Compliance items will lose their assignment but won't be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteContractor.mutate()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
