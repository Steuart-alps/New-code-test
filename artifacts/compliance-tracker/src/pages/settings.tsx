import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { cn } from "@/lib/utils";
import { AppLayout } from "@/components/layout";
import { useGetSettings, useGetStorageUsage } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { apiFetch as authenticatedApiFetch } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Settings2, Mail, Send, Bell, CheckCircle2, Globe, RefreshCw, Trash2, Copy, AlertCircle, ExternalLink, CreditCard, Building2, FileText, Download, Users, Plus, X, ChevronDown, ChevronRight, Pencil, ShieldCheck, ShieldOff, KeyRound, Camera, AlertTriangle, Route, ClipboardCheck, Package, HardDrive } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { clearModuleActivation, trackModuleActivation } from "@/lib/analytics";
interface DomainRecord {
  record?: string;
  name: string;
  type: string;
  value: string;
  ttl?: string | number;
  priority?: number;
  status?: string;
}

interface DomainState {
  configured: boolean;
  domainId?: string;
  domainName: string | null;
  status: string | null;
  records: DomainRecord[];
}

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");

async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === "verified") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold">
        <CheckCircle2 className="w-3.5 h-3.5" /> Verified
      </span>
    );
  }
  if (status === "failed" || status === "temporary_failure") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-50 text-rose-700 border border-rose-200 text-xs font-semibold">
        <AlertCircle className="w-3.5 h-3.5" /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 border border-amber-200 text-xs font-semibold">
      <RefreshCw className="w-3.5 h-3.5" /> Pending verification
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
}

function StorageUsageCard() {
  const { toast } = useToast();
  const { activeClientId } = useAuth();
  const [thresholdGb, setThresholdGb] = useState("5");
  const [saving, setSaving] = useState(false);
  const [storagePurchaseBusy, setStoragePurchaseBusy] = useState(false);
  const usageQuery = useGetStorageUsage({
    query: {
      queryKey: ["/api/storage/usage", activeClientId],
      enabled: activeClientId !== null,
      retry: false,
    },
  });
  const usage = usageQuery.data;

  useEffect(() => {
    if (usage) {
      setThresholdGb(String(Number((usage.warningThresholdBytes / (1024 ** 3)).toFixed(3))));
    }
  }, [usage]);

  const saveThreshold = async () => {
    const gigabytes = Number(thresholdGb);
    const bytes = Math.round(gigabytes * 1024 ** 3);
    if (!Number.isFinite(gigabytes) || gigabytes <= 0 || bytes < 1024 ** 2) {
      toast({ title: "Enter a warning threshold of at least 0.001 GB", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const response = await authenticatedApiFetch(`/settings?clientId=${activeClientId}`, {
        method: "PUT",
        body: JSON.stringify({ storageWarningThresholdBytes: String(bytes) }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? `Request failed (${response.status})`);
      }
      await usageQuery.refetch();
      toast({ title: "Storage warning threshold saved" });
    } catch (err: any) {
      toast({ title: "Couldn't save storage warning", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const buyAdditionalStorage = async () => {
    const excessBytes = usage?.estimatedCost?.excessStorageBytes ?? 0;
    const gib = Math.max(1, Math.ceil(excessBytes / (1024 ** 3)));
    setStoragePurchaseBusy(true);
    try {
      const response = await authenticatedApiFetch("/billing/storage", {
        method: "POST",
        body: JSON.stringify({ gib, requestId: crypto.randomUUID() }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
      toast({
        title: "Additional storage added",
        description: `${gib} GiB has been added to your monthly Stripe subscription.`,
      });
      await usageQuery.refetch();
    } catch (err: any) {
      toast({ title: "Couldn't add storage", description: err.message, variant: "destructive" });
    } finally {
      setStoragePurchaseBusy(false);
    }
  };

  const percent = usage
    ? Math.min(100, Math.round((usage.usedBytes / usage.warningThresholdBytes) * 100))
    : 0;

  return (
    <Card className="shadow-lg border-border/50 bg-card">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-sky-600" />
          <CardTitle className="font-display">File Storage</CardTitle>
        </div>
        <CardDescription>
          Monitor retained documents and evidence for this account. The warning is informational and never blocks or deletes files.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-5">
        {usageQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" /> Calculating current usage…
          </div>
        ) : usage ? (
          <>
            {usage.warning && (
              <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <div>
                  <p className="font-medium">Storage warning threshold reached</p>
                  <p className="text-sm">Review retained files or raise the warning level. Uploads will continue normally.</p>
                </div>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">Retained storage</p>
                <p className="mt-1 text-2xl font-semibold">{formatBytes(usage.usedBytes)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{usage.objectCount.toLocaleString()} stored {usage.objectCount === 1 ? "file" : "files"}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">Downloads this month</p>
                <p className="mt-1 text-2xl font-semibold">
                  {usage.monthlyDownloadTrackingAvailable && usage.monthlyDownloadBytes !== null
                    ? formatBytes(usage.monthlyDownloadBytes)
                    : "Not available"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {usage.monthlyDownloadTrackingAvailable
                    ? `Authoritative streamed traffic for ${usage.month}. Retries and partial downloads count separately.`
                    : "Download traffic is not currently measured."}
                </p>
                <p className="mt-2 text-sm font-medium">
                  {usage.estimatedCost
                    ? (usage.estimatedCost.excessStorageBytes ?? 0) > 0
                      ? `Estimated excess storage charge: $${(usage.estimatedCost.totalMinorUnits / 100).toFixed(2)} / month`
                      : `Within the included ${formatBytes(usage.estimatedCost.includedStorageBytes)} storage allowance`
                    : "Storage pricing is currently unavailable for this subscription."}
                </p>
                {usage.estimatedCost && (usage.estimatedCost.excessStorageBytes ?? 0) > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Based on Replit’s storage cost plus a {usage.estimatedCost.markupPercent ?? 20}% ALPS margin.
                    Downloads are measured separately and are not charged here.
                  </p>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={buyAdditionalStorage}
                  disabled={storagePurchaseBusy}
                >
                  {storagePurchaseBusy ? <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" /> : <CreditCard className="mr-1.5 h-4 w-4" />}
                  {storagePurchaseBusy ? "Adding storage to Stripe…" : "Buy additional storage"}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>{percent}% of warning level</span>
                <span className="text-muted-foreground">{formatBytes(usage.warningThresholdBytes)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full ${usage.warning ? "bg-amber-500" : "bg-sky-600"}`} style={{ width: `${percent}%` }} />
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Storage usage is temporarily unavailable.</p>
            <Button type="button" size="sm" variant="outline" onClick={() => usageQuery.refetch()}>Try again</Button>
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="storage-warning-gb">Warn me at (GB)</Label>
            <Input
              id="storage-warning-gb"
              type="number"
              min="0.001"
              max="10240"
              step="0.1"
              value={thresholdGb}
              onChange={(event) => setThresholdGb(event.target.value)}
            />
          </div>
          <Button type="button" variant="outline" disabled={saving || usageQuery.isLoading || activeClientId === null} onClick={saveThreshold}>
            {saving ? "Saving…" : "Save warning level"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Local types used by DepartmentsCard ──────────────────────────────────────
interface Department { id: number; clientId: number; name: string; description?: string | null; createdAt: string; }
interface DeptUser { id: number; name: string; email: string; role: string; departmentId?: number | null; active?: boolean; }
interface DeptSite { id: number; name: string; departmentId?: number | null; }

function DepartmentsCard() {
  const { toast } = useToast();
  const canAdmin = useCanAdmin();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<DeptUser[]>([]);
  const [sites, setSites] = useState<DeptSite[]>([]);
  const [loading, setLoading] = useState(true);

  // Expanded row, inline-editing state
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  // New department inline form
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const [busy, setBusy] = useState(false);
  const [deptToDelete, setDeptToDelete] = useState<{ id: number; name: string } | null>(null);

  const refresh = async () => {
    try {
      const [depts, userList, siteList] = await Promise.all([
        apiFetch<Department[]>("/departments"),
        apiFetch<DeptUser[]>("/users"),
        apiFetch<DeptSite[]>("/sites"),
      ]);
      setDepartments(depts);
      setUsers(userList);
      setSites(siteList);
    } catch (err: any) {
      toast({ title: "Couldn't load departments", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const toggleExpanded = (id: number) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const createDept = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await apiFetch("/departments", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setNewName("");
      setCreating(false);
      await refresh();
    } catch (err: any) {
      toast({ title: "Failed to create department", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const saveName = async (id: number) => {
    const name = editName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await apiFetch(`/departments/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
      setEditingId(null);
      await refresh();
    } catch (err: any) {
      toast({ title: "Failed to rename", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteDept = async () => {
    if (!deptToDelete) return;
    setBusy(true);
    try {
      // The confirm dialog already lists the affected staff/sites, so proceed
      // with force=true to satisfy the server's deletion-warning guard.
      await apiFetch(`/departments/${deptToDelete.id}?force=true`, { method: "DELETE" });
      setDeptToDelete(null);
      await refresh();
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const assignUser = async (userId: number, departmentId: number | null) => {
    setBusy(true);
    try {
      await apiFetch(`/users/${userId}`, { method: "PUT", body: JSON.stringify({ departmentId }) });
      await refresh();
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const assignSite = async (siteId: number, departmentId: number | null) => {
    setBusy(true);
    try {
      await apiFetch(`/sites/${siteId}`, { method: "PATCH", body: JSON.stringify({ departmentId }) });
      await refresh();
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const deleteAffectedUsers = deptToDelete ? users.filter(u => u.departmentId === deptToDelete.id) : [];
  const deleteAffectedSites = deptToDelete ? sites.filter(s => s.departmentId === deptToDelete.id) : [];
  const deleteHasAssignments = deleteAffectedUsers.length > 0 || deleteAffectedSites.length > 0;

  return (
    <>
    <Card className="shadow-lg border-border/50 bg-card">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-violet-500" />
          <CardTitle className="font-display">Departments</CardTitle>
        </div>
        <CardDescription>
          Organise your sites and staff into departments. Staff and viewer accounts assigned to a
          department will only see data for sites in that department. Users or sites with no
          department assignment can see everything.
        </CardDescription>
      </CardHeader>

      <CardContent className="p-6 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : departments.length === 0 && !creating ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
            No departments yet.
            {canAdmin && (
              <div className="mt-3">
                <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                  <Plus className="w-4 h-4 mr-1.5" /> Create your first department
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            {departments.map(dept => {
              const members = users.filter(u => u.departmentId === dept.id);
              const deptSites = sites.filter(s => s.departmentId === dept.id);
              const isOpen = expanded.has(dept.id);
              const isEditing = editingId === dept.id;

              // Users and sites not assigned to this dept (for add dropdowns)
              const unassignedUsers = users.filter(
                u => u.departmentId !== dept.id && u.role !== "consultant",
              );
              const unassignedSites = sites.filter(s => s.departmentId !== dept.id);

              return (
                <div key={dept.id} className="rounded-xl border border-border/60 overflow-hidden">
                  {/* Row header */}
                  <div
                    className="flex items-center gap-3 px-4 py-3 bg-muted/10 cursor-pointer hover:bg-muted/20 transition-colors"
                    onClick={() => !isEditing && toggleExpanded(dept.id)}
                  >
                    <span className="text-muted-foreground">
                      {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </span>

                    {isEditing ? (
                      <div
                        className="flex items-center gap-2 flex-1"
                        onClick={e => e.stopPropagation()}
                      >
                        <Input
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter") saveName(dept.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="h-7 text-sm py-0 w-48"
                          autoFocus
                        />
                        <Button size="sm" className="h-7 px-2 text-xs" onClick={() => saveName(dept.id)} disabled={busy}>Save</Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <span className="flex-1 font-medium text-sm">{dept.name}</span>
                    )}

                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {members.length} {members.length === 1 ? "member" : "members"} · {deptSites.length} {deptSites.length === 1 ? "site" : "sites"}
                    </span>

                    {canAdmin && !isEditing && (
                      <div className="flex items-center gap-1 ml-1" onClick={e => e.stopPropagation()}>
                        <Button
                          size="sm" variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          title="Rename"
                          onClick={() => { setEditingId(dept.id); setEditName(dept.name); }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          title="Delete"
                          onClick={() => setDeptToDelete({ id: dept.id, name: dept.name })}
                          disabled={busy}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Expanded detail */}
                  {isOpen && (
                    <div className="px-4 py-3 space-y-4 bg-background border-t border-border/40">
                      {/* Members */}
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Members</p>
                        {members.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">No members yet.</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {members.map(u => (
                              <span
                                key={u.id}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-50 border border-violet-200 text-xs text-violet-800"
                              >
                                {u.name}
                                {canAdmin && (
                                  <button
                                    className="hover:text-destructive ml-0.5"
                                    title={`Remove ${u.name}`}
                                    onClick={() => assignUser(u.id, null)}
                                    disabled={busy}
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                        {canAdmin && unassignedUsers.length > 0 && (
                          <Select onValueChange={val => assignUser(Number(val), dept.id)} disabled={busy}>
                            <SelectTrigger className="h-7 text-xs w-52">
                              <SelectValue placeholder="+ Add member…" />
                            </SelectTrigger>
                            <SelectContent>
                              {unassignedUsers.map(u => (
                                <SelectItem key={u.id} value={String(u.id)} className="text-xs">
                                  {u.name} <span className="text-muted-foreground ml-1">({u.role.replace("client_", "")})</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>

                      {/* Sites */}
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Sites</p>
                        {deptSites.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">No sites assigned yet.</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {deptSites.map(s => (
                              <span
                                key={s.id}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-xs text-blue-800"
                              >
                                {s.name}
                                {canAdmin && (
                                  <button
                                    className="hover:text-destructive ml-0.5"
                                    title={`Remove ${s.name}`}
                                    onClick={() => assignSite(s.id, null)}
                                    disabled={busy}
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                        {canAdmin && unassignedSites.length > 0 && (
                          <Select onValueChange={val => assignSite(Number(val), dept.id)} disabled={busy}>
                            <SelectTrigger className="h-7 text-xs w-52">
                              <SelectValue placeholder="+ Assign site…" />
                            </SelectTrigger>
                            <SelectContent>
                              {unassignedSites.map(s => (
                                <SelectItem key={s.id} value={String(s.id)} className="text-xs">
                                  {s.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* New department inline form */}
            {canAdmin && (
              creating ? (
                <div className="flex items-center gap-2 pt-1">
                  <Input
                    placeholder="Department name"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") createDept();
                      if (e.key === "Escape") { setCreating(false); setNewName(""); }
                    }}
                    className="h-8 text-sm w-52"
                    autoFocus
                  />
                  <Button size="sm" onClick={createDept} disabled={busy || !newName.trim()}>Create</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName(""); }}>Cancel</Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={() => setCreating(true)}
                >
                  <Plus className="w-4 h-4 mr-1.5" /> New Department
                </Button>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>

    {/* Delete department confirmation dialog */}
    <Dialog open={!!deptToDelete} onOpenChange={(open) => { if (!open) setDeptToDelete(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-destructive" />
            Delete "{deptToDelete?.name}"?
          </DialogTitle>
          {deleteHasAssignments ? (
            <DialogDescription asChild>
              <div className="mt-2 space-y-2">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                  <span>
                    Deleting this department will <strong>unassign</strong> the following — they won't be deleted, but will lose their department association.
                  </span>
                </div>
                {deleteAffectedUsers.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                      Staff ({deleteAffectedUsers.length})
                    </p>
                    <ul className="space-y-0.5">
                      {deleteAffectedUsers.slice(0, 5).map((u) => (
                        <li key={u.id} className="text-sm text-foreground flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                          {u.name || u.email}
                        </li>
                      ))}
                      {deleteAffectedUsers.length > 5 && (
                        <li className="text-xs text-muted-foreground pl-3">+{deleteAffectedUsers.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                )}
                {deleteAffectedSites.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                      Sites ({deleteAffectedSites.length})
                    </p>
                    <ul className="space-y-0.5">
                      {deleteAffectedSites.slice(0, 5).map((s) => (
                        <li key={s.id} className="text-sm text-foreground flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                          {s.name}
                        </li>
                      ))}
                      {deleteAffectedSites.length > 5 && (
                        <li className="text-xs text-muted-foreground pl-3">+{deleteAffectedSites.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            </DialogDescription>
          ) : (
            <DialogDescription className="text-sm text-muted-foreground mt-1">
              This department has no members or sites assigned. It will be permanently removed.
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={() => setDeptToDelete(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirmDeleteDept} disabled={busy}>
            {busy ? "Deleting…" : "Delete Department"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

const TRACK_SUMMARY_MODULES = [
  { key: "daily_am", label: "DailyTrack AM" },
  { key: "daily_pm", label: "DailyTrack PM" },
  { key: "kitchen", label: "KitchenTrack" },
  { key: "fire", label: "FireTrack" },
  { key: "legionella", label: "LegionellaTrack" },
  { key: "pool", label: "AquaTrack" },
  { key: "pat", label: "PATtrack" },
  { key: "pest", label: "PestTrack" },
  { key: "fix", label: "FixTrack" },
  { key: "premises", label: "PremisesTrack" },
  { key: "room", label: "RoomTrack" },
  { key: "doc", label: "DocTrack" },
  { key: "safe", label: "SafeTrack" },
  { key: "train", label: "TrainTrack" },
  { key: "hot_tub", label: "TubTrack" },
  { key: "tree", label: "TreeTrack" },
  { key: "bike", label: "BikeTrack" },
  { key: "green", label: "GreenTrack" },
  { key: "swim", label: "SwimTrack" },
  { key: "incident", label: "IncidentTrack" },
] as const;

function TrackSummaryRoutingCard({
  value,
  seniorEmail,
  onSaved,
}: {
  value: string | null | undefined;
  seniorEmail: string;
  onSaved: (value: string) => void;
}) {
  const { toast } = useToast();
  const canAdmin = useCanAdmin();
  const [users, setUsers] = useState<DeptUser[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [routing, setRouting] = useState<Record<string, number[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    try {
      const parsed = value ? JSON.parse(value) : {};
      setRouting(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
    } catch {
      setRouting({});
    }
  }, [value]);

  useEffect(() => {
    Promise.all([
      apiFetch<DeptUser[]>("/users"),
      apiFetch<Department[]>("/departments"),
    ])
      .then(([userList, departmentList]) => {
        setUsers(userList);
        setDepartments(departmentList);
      })
      .catch((err: Error) => {
        toast({ title: "Couldn't load track recipients", description: err.message, variant: "destructive" });
      })
      .finally(() => setLoading(false));
  }, []);

  const managers = users.filter(
    (user) => user.active !== false && (user.role === "client_admin" || user.role === "client_staff"),
  );
  const seniorManagers = users.filter((user) => user.active !== false && user.role === "client_admin");

  const toggleManager = (module: string, userId: number) => {
    setRouting((current) => {
      const selected = new Set(current[module] ?? []);
      selected.has(userId) ? selected.delete(userId) : selected.add(userId);
      return { ...current, [module]: [...selected] };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const serialized = JSON.stringify(routing);
      await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({ trackSummaryRouting: serialized }),
      });
      onSaved(serialized);
      toast({ title: "Track summary routing saved" });
    } catch (err: any) {
      toast({ title: "Couldn't save routing", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="shadow-lg border-border/50 bg-card">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <Route className="w-5 h-5 text-sky-600" />
          <CardTitle className="font-display">Track Summary Recipients</CardTitle>
        </div>
        <CardDescription>
          Senior management receives every track. Assign the relevant department managers below so they receive only the tracks they oversee.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-5">
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          <p className="font-semibold">Senior management — all tracks</p>
          <p className="mt-1 text-xs text-sky-800">
            {seniorEmail.trim()
              ? seniorEmail
              : seniorManagers.length > 0
                ? seniorManagers.map((manager) => manager.email).join(", ")
                : "No admin/owner notification recipient is currently configured."}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : managers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add an admin or staff account before assigning department managers to tracks.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {TRACK_SUMMARY_MODULES.map((track) => {
              const selectedIds = routing[track.key] ?? [];
              const selectedManagers = managers.filter((manager) => selectedIds.includes(manager.id));
              return (
                <details key={track.key} className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-muted/30">
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
                    <span className="flex-1 text-sm font-medium">{track.label}</span>
                    <span className="max-w-[55%] truncate text-xs text-muted-foreground">
                      {selectedManagers.length > 0
                        ? selectedManagers.map((manager) => manager.name).join(", ")
                        : "Senior management only"}
                    </span>
                  </summary>
                  <div className="grid gap-2 border-t border-border/60 bg-muted/10 px-10 py-3 sm:grid-cols-2">
                    {managers.map((manager) => {
                      const department = departments.find((item) => item.id === manager.departmentId);
                      return (
                        <label key={manager.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background p-2.5 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                            checked={selectedIds.includes(manager.id)}
                            onChange={() => toggleManager(track.key, manager.id)}
                            disabled={!canAdmin || saving}
                          />
                          <span>
                            <span className="block font-medium">{manager.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {department?.name ?? (manager.role === "client_admin" ? "Account admin" : "No department")}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </div>
        )}

        {canAdmin && (
          <Button type="button" onClick={save} disabled={saving || loading}>
            {saving ? "Saving…" : "Save Track Recipients"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function SenderDomainCard() {
  const { toast } = useToast();
  const [state, setState] = useState<DomainState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [domainInput, setDomainInput] = useState("");

  const refresh = async () => {
    try {
      const data = await apiFetch<DomainState>("/email-domain");
      setState(data);
    } catch (err: any) {
      toast({ title: "Couldn't load domain", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const register = async () => {
    if (!domainInput.trim()) return;
    setBusy(true);
    try {
      const data = await apiFetch<DomainState>("/email-domain", {
        method: "POST",
        body: JSON.stringify({ name: domainInput.trim() }),
      });
      setState(data);
      setDomainInput("");
      toast({ title: "Domain added", description: "Add the DNS records below to your DNS provider, then verify." });
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    try {
      const data = await apiFetch<DomainState>("/email-domain/verify", { method: "POST" });
      setState(data);
      if (data.status === "verified") {
        toast({ title: "Domain verified!", description: "You can now send emails from this domain." });
      } else {
        toast({ title: "Still pending", description: "DNS records may take up to 24 hours to propagate. Try again shortly." });
      }
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const removeDomain = async () => {
    if (!confirm("Remove this sender domain? Emails will fall back to the default sender.")) return;
    setBusy(true);
    try {
      const data = await apiFetch<DomainState>("/email-domain", { method: "DELETE" });
      setState(data);
      toast({ title: "Domain removed" });
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value);
    toast({ title: "Copied to clipboard" });
  };

  return (
    <Card className="shadow-lg border-border/50 bg-card mb-6">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <Globe className="w-5 h-5 text-emerald-600" />
          <CardTitle className="font-display">Sender Domain</CardTitle>
        </div>
        <CardDescription>
          Use your own business email address instead of the default sender. We’ll show you the small setup step needed for your domain.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-5">
        {loading ? (
          <div className="py-6 flex justify-center"><div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : !state?.configured ? (
          <div className="space-y-3">
            <Label>Your sending domain</Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="yourcompany.co.uk"
                className="flex-1"
              />
              <Button onClick={register} disabled={busy || !domainInput.trim()}>
                {busy ? "Adding..." : "Add Domain"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter your website domain, such as <code>yourcompany.co.uk</code>. We’ll then show you what to add to your domain provider.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <div className="font-semibold font-display text-lg">{state.domainName}</div>
                <div className="mt-1"><StatusBadge status={state.status} /></div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={verify} disabled={busy}>
                  <RefreshCw className={`w-4 h-4 mr-1.5 ${busy ? "animate-spin" : ""}`} /> Check status
                </Button>
                <Button variant="ghost" size="sm" onClick={removeDomain} disabled={busy} className="text-destructive hover:bg-destructive/10">
                  <Trash2 className="w-4 h-4 mr-1.5" /> Remove
                </Button>
              </div>
            </div>

            {state.status !== "verified" && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5"><AlertCircle className="w-4 h-4" /> Action required</div>
                Add the records below to your domain provider, then click <strong>Check status</strong>. Changes can take up to 24 hours.
              </div>
            )}

            {state.records.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold">Type</th>
                      <th className="px-4 py-2 text-left font-semibold">Name / Host</th>
                      <th className="px-4 py-2 text-left font-semibold">Value</th>
                      <th className="px-4 py-2 text-left font-semibold">TTL</th>
                      <th className="px-4 py-2 text-left font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {state.records.map((r, i) => (
                      <tr key={i} className="align-top">
                        <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{r.type}</td>
                        <td className="px-4 py-3 font-mono text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="break-all">{r.name}</span>
                            <button onClick={() => copy(r.name)} className="opacity-50 hover:opacity-100"><Copy className="w-3 h-3" /></button>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="break-all">{r.value}{r.priority ? ` (priority ${r.priority})` : ""}</span>
                            <button onClick={() => copy(r.value)} className="opacity-50 hover:opacity-100 flex-shrink-0"><Copy className="w-3 h-3" /></button>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{String(r.ttl ?? "Auto")}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {r.status === "verified" ? (
                            <span className="text-emerald-700 inline-flex items-center gap-1 text-xs font-semibold"><CheckCircle2 className="w-3 h-3" /> OK</span>
                          ) : (
                            <span className="text-amber-700 text-xs font-semibold">Pending</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {state.status === "verified" && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Domain verified</div>
                Set the sender email below to an address ending in <strong>@{state.domainName}</strong>.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Email Setup Guide ─────────────────────────────────────────────────────────
// Shown once to paid client admins who haven't yet configured their sender domain
// and From address. Auto-hides when both steps are complete; permanently hidden
// after dismissal (stored server-side as emailSetupGuideDismissed).

function EmailSetupGuide({
  settings,
  onDismiss,
}: {
  settings: Record<string, string | null>;
  onDismiss: () => void;
}) {
  const [domainStatus, setDomainStatus] = useState<{ verified: boolean; loading: boolean }>({
    verified: false,
    loading: true,
  });

  useEffect(() => {
    apiFetch<DomainState>("/email-domain")
      .then(d => setDomainStatus({ verified: !!(d.configured && d.status === "verified"), loading: false }))
      .catch(() => setDomainStatus({ verified: false, loading: false }));
  }, []);

  const domainVerified = domainStatus.verified;
  const fromSet = !!(settings.smtpFrom?.trim());

  // Auto-hide once setup is complete — no need to nag
  if (domainVerified && fromSet) return null;

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const focusLater = (selector: string) =>
    setTimeout(() => document.querySelector<HTMLElement>(selector)?.focus(), 450);

  const steps: {
    id: string;
    num: number;
    label: string;
    detail: string;
    done: boolean;
    loading?: boolean;
    cta: string;
    onClick: () => void;
  }[] = [
    {
      id: "domain",
      num: 1,
      label: "Verify your sender domain",
        detail: "Connect your business email address so messages look familiar to your team.",
      done: domainVerified,
      loading: domainStatus.loading,
      cta: "Set up domain →",
      onClick: () => scrollTo("email-sender-section"),
    },
    {
      id: "from",
      num: 2,
        label: "Choose your sender address",
        detail: "Choose the email address contractors and staff will see.",
      done: fromSet,
      loading: false,
      cta: "Set From address →",
      onClick: () => { scrollTo("email-settings-section"); focusLater('[name="smtpFrom"]'); },
    },
    {
      id: "test",
      num: 3,
      label: "Send a test email",
        detail: "Check that everything is working before sending reminders.",
      done: false,
      loading: false,
      cta: "Send test →",
        onClick: () => { scrollTo("email-settings-section"); focusLater('[placeholder="Send a test to…"]'); },
    },
  ];

  const doneCount = steps.filter(s => s.done).length;

  return (
    <div className="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-blue-50/40 p-5 space-y-4 mb-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center shrink-0">
            <Mail className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-base text-foreground leading-snug">
              Email sender setup
            </h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Choose how your emails appear to contractors and staff. Complete this once.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-0.5">
          <span className={cn(
            "text-xs font-semibold px-2.5 py-1 rounded-full",
            doneCount === 2
              ? "bg-emerald-100 text-emerald-700"
              : "bg-indigo-100 text-indigo-700",
          )}>
            {doneCount}/2 done
          </span>
          <Button
            variant="ghost" size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
            type="button"
            title="Dismiss this guide"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Step cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {steps.map(step => (
          <button
            key={step.id}
            type="button"
            onClick={step.onClick}
            disabled={step.loading}
            className={cn(
              "text-left rounded-lg border p-4 space-y-2.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              step.done
                ? "border-emerald-200 bg-emerald-50/70 cursor-default"
                : "border-indigo-200/60 bg-white/60 hover:bg-white/90 hover:border-indigo-300 hover:shadow-sm",
            )}
          >
            {/* Step number / tick */}
            <div className="flex items-center justify-between">
              <div className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                step.done
                  ? "bg-emerald-500 text-white"
                  : step.loading
                  ? "bg-muted text-muted-foreground animate-pulse"
                  : "bg-indigo-100 text-indigo-700",
              )}>
                {step.done
                  ? <CheckCircle2 className="w-3.5 h-3.5" />
                  : <span>{step.num}</span>
                }
              </div>
              {step.done && (
                <span className="text-xs font-semibold text-emerald-600">Complete ✓</span>
              )}
            </div>

            {/* Label + detail */}
            <div>
              <p className={cn(
                "text-sm font-semibold leading-snug",
                step.done && "line-through text-muted-foreground",
              )}>
                {step.label}
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">{step.detail}</p>
            </div>

            {/* CTA link */}
            {!step.done && !step.loading && (
              <p className="text-xs font-semibold text-indigo-600">{step.cta}</p>
            )}
          </button>
        ))}
      </div>

      {/* Footer */}
      <p className="text-xs text-center text-muted-foreground/60">
        This banner disappears automatically once your domain is verified and From address is set.{" "}
        <button type="button" onClick={onDismiss} className="underline hover:text-muted-foreground">
          Dismiss now.
        </button>
      </p>
    </div>
  );
}

interface BillingConfig {
  subscription?: { status?: string } | null;
  siteCount: number;
  perSite: { priceId: string; unitAmount: number; currency: string } | null;
  billableQuantity: number;
  monthlyTotal: number | null;
  cancelledAt?: string | null;
  dataDeletionScheduledAt?: string | null;
  dataDeletedAt?: string | null;
  services?: {
    entitled: "all" | string[];
    addons: string[];
    bundle: boolean;
    subscribed: boolean;
    perSiteRate: number;
    capPence: number;
    catalog: { key: string; label: string; amountPence: number }[];
  };
}

function BillingCard() {
  const { toast } = useToast();
  const { refresh: refreshAuth, activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const fetchConfig = () => {
    apiFetch<BillingConfig>("/billing/config")
      .then(setConfig)
      .catch(() => setConfig(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const openPortal = async () => {
    setBusy(true);
    try {
      const data = await apiFetch<{ url: string }>("/billing/portal", { method: "POST" });
      if (data.url) window.location.href = data.url;
    } catch (err: any) {
      toast({ title: "Couldn't open billing portal", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const startCheckout = async () => {
    setCheckoutBusy(true);
    try {
      const data = await apiFetch<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!data.url) throw new Error("Could not start checkout");
      window.location.href = data.url;
    } catch (err: any) {
      toast({ title: "Couldn't start checkout", description: err.message, variant: "destructive" });
      setCheckoutBusy(false);
    }
  };

  const handleServiceAction = async (serviceKey: string, action: "add" | "remove") => {
    const isAdd = action === "add";
    const amountPence = config?.services?.catalog.find((c) => c.key === serviceKey)?.amountPence || 1000;
    const amount = amountPence / 100;
    const sites = config?.billableQuantity || 1;
    const initialCost = amount * sites;

    if (isAdd) {
      if (!confirm(`You'll be charged a full month for ${sites} site(s) now (£${initialCost}); renews monthly with your subscription.`)) return;
    } else {
      if (!confirm("Takes effect immediately. No refund for the current month.")) return;
    }

    setActionBusy(serviceKey);
    try {
      const res = await apiFetch<{ ok: boolean; paymentPending?: boolean }>("/billing/services", {
        method: "POST",
        body: JSON.stringify({ service: serviceKey, action }),
      });
      if (res.paymentPending) {
        toast({ title: "Payment pending", description: "Action succeeded but the payment requires attention in the billing portal.", variant: "default" });
      } else {
        toast({ title: `Service ${isAdd ? "added" : "removed"} successfully` });
      }
      if (isAdd && !res.paymentPending) {
        trackModuleActivation(activeClientId, serviceKey);
      } else {
        clearModuleActivation(activeClientId, serviceKey);
      }
      fetchConfig();
      await apiFetch("/billing/refresh-access", { method: "POST" }).catch(() => {});
      await refreshAuth();
    } catch (err: any) {
      toast({ title: "Action failed", description: err.message || "Could not update service", variant: "destructive" });
    } finally {
      setActionBusy(null);
    }
  };

  const servicesConfig = config?.services;
  // `subscribed` is the live-Stripe-subscription flag; `subscription.status`
  // can read "active" from local state even with no Stripe subscription.
  const hasSubscription = config?.services?.subscribed === true;
  const perSiteRate = servicesConfig ? servicesConfig.perSiteRate / 100 : (config?.perSite ? config.perSite.unitAmount / 100 : 10);
  const sites = config?.siteCount ?? 0;
  const billable = config?.billableQuantity ?? Math.max(sites, 1);
  const total = config?.monthlyTotal != null ? config.monthlyTotal / 100 : billable * perSiteRate;
  const status = config?.subscription?.status ?? "trial";

  return (
    <>
      <Card id="billing" className="shadow-lg border-border/50 bg-card mb-6">
        <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-primary" />
            <CardTitle className="font-display">Billing &amp; Subscription</CardTitle>
          </div>
          <CardDescription>
            You're billed based on active services and sites. Your total scales automatically with the number of sites on your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6 space-y-5">
          {loading ? (
            <div className="py-6 flex justify-center"><div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : (
            <>
              <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 px-4 py-4">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 p-2 rounded-lg">
                    <Building2 className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <div className="font-semibold">
                      £{perSiteRate.toFixed(0)} per site × {billable} {billable === 1 ? "site" : "sites"}
                    </div>
                    {sites === 0 && (
                      <div className="text-xs text-muted-foreground">Minimum of one site is billed.</div>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold font-display">£{total.toFixed(0)}</div>
                  <div className="text-xs text-muted-foreground">per month</div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="text-sm text-muted-foreground">
                  Status: <span className="font-medium text-foreground capitalize">{status}</span>
                </div>
                {hasSubscription ? (
                  <Button variant="outline" onClick={openPortal} disabled={busy}>
                    <ExternalLink className="w-4 h-4 mr-1.5" /> {busy ? "Opening…" : "Manage subscription"}
                  </Button>
                ) : canAdmin ? (
                  <Button onClick={startCheckout} disabled={checkoutBusy}>
                    <CreditCard className="w-4 h-4 mr-1.5" /> {checkoutBusy ? "Opening checkout…" : "Set up billing"}
                  </Button>
                ) : null}
              </div>

              {config?.dataDeletionScheduledAt && !config?.dataDeletedAt && (
                <div className="flex items-start gap-3 rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-900/50 dark:bg-orange-950/30">
                  <AlertTriangle className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-semibold text-orange-800 dark:text-orange-300">Your data is scheduled for deletion</p>
                    <p className="text-orange-700 dark:text-orange-400 mt-0.5">
                      All compliance records will be permanently deleted on{" "}
                      <strong>
                        {new Date(config.dataDeletionScheduledAt).toLocaleDateString("en-GB", {
                          weekday: "long", year: "numeric", month: "long", day: "numeric",
                        })}
                      </strong>{" "}
                      — 12 months after your subscription ended. Resubscribe before this date to keep your records, or download them now.
                    </p>
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground border-t border-border/50 pt-3">
                Each billing period is one month. Added sites and services are charged a full month up front; removed sites and cancellations take effect at the end of the paid month — no refunds or part-month credits.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {!loading && servicesConfig && (
        <Card className="shadow-lg border-border/50 bg-card mb-6">
          <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
            <CardTitle className="font-display text-lg">Services</CardTitle>
            <CardDescription>Add or remove services from your account.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {servicesConfig.bundle ? (
              <div className="p-6 text-center text-sm text-muted-foreground bg-primary/5">
                <CheckCircle2 className="w-8 h-8 text-primary mx-auto mb-3" />
                <span className="font-medium text-foreground text-base block mb-1">ComplyTrack Complete Bundle Active</span>
                All current and future services are included in your bundle.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {servicesConfig.catalog
                  .filter(c => c.key !== "core" && c.key !== "bundle")
                  .map(service => {
                  // "Active" means it's on the paid subscription — not merely
                  // entitled via a trial (trials unlock everything for free).
                  const isActive = servicesConfig.addons.includes(service.key);
                  const onTrial = !hasSubscription && (servicesConfig.entitled === "all" || servicesConfig.entitled.includes(service.key));
                  return (
                    <div key={service.key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6">
                      <div>
                        <div className="font-medium text-base">{service.label}</div>
                        <div className="text-sm text-muted-foreground mt-1">
                          £{(service.amountPence / 100).toFixed(0)}/site/month
                        </div>
                        <div className="mt-2">
                          {isActive ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Active
                            </span>
                          ) : onTrial ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-xs font-semibold">
                              Included in your trial
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted text-muted-foreground border border-border text-xs font-semibold">
                              Not enabled
                            </span>
                          )}
                        </div>
                      </div>
                      {canAdmin && !hasSubscription ? (
                        <div className="text-xs text-muted-foreground max-w-[200px] text-right">
                          Choose your services when you subscribe
                        </div>
                      ) : canAdmin && (
                        <div>
                          {isActive ? (
                            <Button 
                              variant="outline" 
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                              disabled={actionBusy === service.key}
                              onClick={() => handleServiceAction(service.key, "remove")}
                            >
                              {actionBusy === service.key ? "Removing..." : "Remove"}
                            </Button>
                          ) : (
                            <Button 
                              disabled={actionBusy === service.key}
                              onClick={() => handleServiceAction(service.key, "add")}
                            >
                              {actionBusy === service.key ? "Adding..." : "Add"}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

interface ModuleState { safetrack: { enabled: boolean }; dailytrack: { enabled: boolean } }
interface InvoiceRow {
  id: string;
  number: string | null;
  status: string | null;
  created: number;
  currency: string;
  amountDue: number;
  amountPaid: number;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

function DataExportCard() {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const canAdmin = useCanAdmin();
  useEffect(() => {
    if (canAdmin && window.location.hash === "#data-export") {
      const frame = window.requestAnimationFrame(() => {
        document.getElementById("data-export")?.scrollIntoView({ block: "start" });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [canAdmin]);
  if (!canAdmin) return null;

  async function handleExport() {
    setBusy(true);
    try {
      const res = await apiFetch("/export");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `complytrack-export-${date}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="data-export" className="scroll-mt-6 shadow-lg border-border/50 bg-card">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <Download className="w-5 h-5 text-primary" />
          <CardTitle className="font-display">Data Export</CardTitle>
        </div>
        <CardDescription>
          Download all your compliance records as a ZIP file containing CSVs for every module — food safety, fire safety, documents, training, contractors and more. Useful before cancelling or for offline audit archives.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6">
        <div className="flex items-start gap-4">
          <div className="flex-1 text-sm text-muted-foreground space-y-1">
            <p>The export includes every record scoped to your account: sites, departments, staff, all compliance logs and contractor records.</p>
            <p className="text-xs">Available private file attachments (PDFs, photos) are included in the ZIP. Check its manifest for any files that could not be bundled.</p>
          </div>
          <Button onClick={handleExport} disabled={busy} className="shrink-0 gap-2">
            {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {busy ? "Preparing…" : "Export all data"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function InvoicesCard() {
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ invoices: InvoiceRow[] }>("/billing/invoices")
      .then((d) => setInvoices(d.invoices))
      .catch((err: any) => setError(err.message || "Couldn't load invoices"));
  }, []);

  const fmtAmount = (inv: InvoiceRow) => {
    const amount = (inv.status === "paid" ? inv.amountPaid : inv.amountDue) / 100;
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: (inv.currency || "gbp").toUpperCase() }).format(amount);
  };

  return (
    <Card className="shadow-lg border-border/50 bg-card mb-6">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          <CardTitle className="font-display">Invoices</CardTitle>
        </div>
        <CardDescription>
          Invoices are issued by Stripe each billing cycle and emailed to you automatically. Download past invoices here.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6">
        {error ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        ) : invoices === null ? (
          <div className="py-6 flex justify-center"><div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : invoices.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No invoices yet. Your first invoice will appear here after your first billing cycle.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">
                    {inv.number ?? inv.id}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(inv.created * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    {" · "}
                    <span className="capitalize">{inv.status ?? "unknown"}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="font-semibold text-sm">{fmtAmount(inv)}</div>
                  {inv.hostedInvoiceUrl && (
                    <a href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline text-xs inline-flex items-center gap-1">
                      <ExternalLink className="w-3.5 h-3.5" /> View
                    </a>
                  )}
                  {inv.invoicePdf && (
                    <a href={inv.invoicePdf} target="_blank" rel="noreferrer" className="text-primary hover:underline text-xs inline-flex items-center gap-1">
                      <Download className="w-3.5 h-3.5" /> PDF
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


// ── Photo requirement labels ─────────────────────────────────────────────────
const PHOTO_ENTITY_LABELS: Record<string, string> = {
  fire_safety_check: "FireTrack — fire safety checks",
  pool_check:        "PoolTrack — pool water tests",
  hot_tub_check:     "TubTrack — hot tub checks",
  legionella_check:  "LegionellaTrack — water safety checks",
  tree_inspection:   "TreeTrack — tree inspections",
  bike_check:        "BikeTrack — pre/post hire checks",
  bike_hire:         "BikeTrack — hire records",
  bike_service:      "BikeTrack — service records",
  daily_check_am:    "DailyTrack — AM opening checks",
  daily_check_pm:    "DailyTrack — PM closing checks",
  safe_track_record: "SafeTrack — safety records",
  food_safety_check: "KitchenTrack — food safety records",
  green_pre_use_check:       "GreenTrack — pre-use checks",
  green_service:             "GreenTrack — service records",
  green_defect:              "GreenTrack — defect reports",
  swim_session:              "SwimTrack — pool sessions",
  swim_surveillance_check:   "SwimTrack — surveillance checks",
  swim_first_aid_check:      "SwimTrack — first-aid checks",
  swim_incident:             "SwimTrack — incident records",
};

function PhotoRequirementsCard() {
  const canAdmin = useCanAdmin();
  const { toast } = useToast();
  const [requirements, setRequirements] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<{ entity_type: string; required: boolean }[]>("/photos/requirements")
      .then(rows => {
        const map: Record<string, boolean> = {};
        rows.forEach((r: { entity_type: string; required: boolean }) => { map[r.entity_type] = r.required; });
        setRequirements(map);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = (entityType: string) => {
    setRequirements(prev => ({ ...prev, [entityType]: !prev[entityType] }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const items = Object.keys(PHOTO_ENTITY_LABELS).map(k => ({
        entityType: k,
        required: requirements[k] ?? false,
        minPhotos: 1,
      }));
      await apiFetch("/photos/requirements", { method: "PUT", body: JSON.stringify(items) });
      toast({ title: "Photo requirements saved" });
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (!canAdmin) return null;

  return (
    <Card className="shadow-lg border-border/50 bg-card mb-6">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-primary" />
          <CardTitle className="font-display">Photo Requirements</CardTitle>
        </div>
        <CardDescription>
          Choose which record types must include at least one photo. Staff will see a <strong>Required</strong> badge on those records.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6 flex justify-center">
            <div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : (
          <>
            <div className="divide-y divide-border">
              {Object.entries(PHOTO_ENTITY_LABELS).map(([k, label]) => (
                <div key={k} className="flex items-center justify-between gap-4 px-6 py-3">
                  <span className="text-sm">{label}</span>
                  <button
                    type="button"
                    onClick={() => toggle(k)}
                    aria-label={requirements[k] ? "Required — click to disable" : "Optional — click to require"}
                    className={[
                      "relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      requirements[k] ? "bg-primary" : "bg-border",
                    ].join(" ")}
                  >
                    <span className={[
                      "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                      requirements[k] ? "translate-x-4" : "translate-x-1",
                    ].join(" ")} />
                  </button>
                </div>
              ))}
            </div>
            <div className="px-6 pb-4 pt-3 border-t border-border/50">
              <Button onClick={handleSave} disabled={saving} size="sm">
                {saving ? "Saving…" : "Save Requirements"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type RequiredActionTemplate = {
  id: number;
  title: string;
  module: string | null;
  instruction?: string | null;
  severity: "monitor" | "action_required" | "urgent";
  ownerDefault?: string | null;
  leadTimeDays?: number | null;
  siteId?: number | null;
  departmentId?: number | null;
  enabled?: boolean;
  active?: boolean;
  sortOrder?: number | null;
};

const emptyActionTemplate: { title: string; module: string; instruction: string; severity: RequiredActionTemplate["severity"]; ownerName: string; leadTimeDays: string; siteId: string; departmentId: string } = {
  title: "", module: "fire", instruction: "", severity: "action_required",
  ownerName: "", leadTimeDays: "7", siteId: "", departmentId: "",
};

function RequiredActionTemplatesCard() {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<RequiredActionTemplate[]>([]);
  const [sites, setSites] = useState<DeptSite[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [draft, setDraft] = useState(emptyActionTemplate);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [templateData, siteData, departmentData] = await Promise.all([
        apiFetch<RequiredActionTemplate[] | { templates: RequiredActionTemplate[] }>("/track-actions/templates"),
        apiFetch<DeptSite[]>("/sites"),
        apiFetch<Department[]>("/departments"),
      ]);
      setTemplates(Array.isArray(templateData) ? templateData : templateData.templates ?? []);
      setSites(siteData);
      setDepartments(departmentData);
    } catch (err: any) {
      toast({ title: "Couldn't load action templates", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const beginEdit = (template: RequiredActionTemplate) => {
    setEditingId(template.id);
    setDraft({
      title: template.title, module: template.module ?? "", instruction: template.instruction ?? "",
      severity: template.severity, ownerName: template.ownerDefault ?? "",
      leadTimeDays: String(template.leadTimeDays ?? 0),
      siteId: template.siteId ? String(template.siteId) : "",
      departmentId: template.departmentId ? String(template.departmentId) : "",
    });
  };

  const save = async () => {
    if (!draft.title.trim()) return;
    setBusy(true);
    const body = {
      title: draft.title.trim(), module: draft.module || null, instruction: draft.instruction.trim(),
      severity: draft.severity, ownerDefault: draft.ownerName.trim() || null,
      leadTimeDays: Math.max(0, Number(draft.leadTimeDays) || 0),
      siteId: draft.siteId ? Number(draft.siteId) : null,
      departmentId: draft.departmentId ? Number(draft.departmentId) : null,
    };
    try {
      await apiFetch(editingId ? `/track-actions/templates/${editingId}` : "/track-actions/templates", {
        method: editingId ? "PATCH" : "POST", body: JSON.stringify(body),
      });
      toast({ title: editingId ? "Action template updated" : "Action template created" });
      setEditingId(null);
      setDraft(emptyActionTemplate);
      await refresh();
    } catch (err: any) {
      toast({ title: "Couldn't save action template", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const patchTemplate = async (template: RequiredActionTemplate, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await apiFetch(`/track-actions/templates/${template.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refresh();
    } catch (err: any) {
      toast({ title: "Couldn't update action template", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const move = async (template: RequiredActionTemplate, direction: -1 | 1) => {
    const ordered = [...templates].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const from = ordered.findIndex(item => item.id === template.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    const reordered = [...ordered];
    [reordered[from], reordered[to]] = [reordered[to], reordered[from]];
    setBusy(true);
    try {
      await apiFetch("/track-actions/templates/reorder", {
        method: "POST", body: JSON.stringify({ templateIds: reordered.map(item => item.id) }),
      });
      await refresh();
    } catch (err: any) {
      toast({ title: "Couldn't reorder action templates", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-lg border-border/50 bg-card">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2"><ClipboardCheck className="w-5 h-5 text-primary" /><CardTitle className="font-display">Required Action Templates</CardTitle></div>
        <CardDescription>Standardise actions for each module. Selecting a template creates an editable snapshot, so later template changes do not alter existing actions.</CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-5">
        <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2"><Label>Template title</Label><Input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Arrange emergency lighting repair" /></div>
          <div className="space-y-1.5"><Label>Module</Label><Select value={draft.module || "all"} onValueChange={module => setDraft({ ...draft, module: module === "all" ? "" : module })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All modules</SelectItem>{TRACK_SUMMARY_MODULES.map(item => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Severity</Label><Select value={draft.severity} onValueChange={severity => setDraft({ ...draft, severity: severity as RequiredActionTemplate["severity"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="monitor">Monitor</SelectItem><SelectItem value="action_required">Action required</SelectItem><SelectItem value="urgent">Urgent</SelectItem></SelectContent></Select></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Instruction</Label><Textarea value={draft.instruction} onChange={e => setDraft({ ...draft, instruction: e.target.value })} placeholder="Explain the required work or evidence." /></div>
          <div className="space-y-1.5"><Label>Default owner</Label><Input value={draft.ownerName} onChange={e => setDraft({ ...draft, ownerName: e.target.value })} placeholder="Role or person" /></div>
          <div className="space-y-1.5"><Label>Lead time (days)</Label><Input type="number" min="0" value={draft.leadTimeDays} onChange={e => setDraft({ ...draft, leadTimeDays: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Site scope <span className="text-muted-foreground">(optional)</span></Label><Select value={draft.siteId || "all"} onValueChange={siteId => setDraft({ ...draft, siteId: siteId === "all" ? "" : siteId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All sites</SelectItem>{sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Department scope <span className="text-muted-foreground">(optional)</span></Label><Select value={draft.departmentId || "all"} onValueChange={departmentId => setDraft({ ...draft, departmentId: departmentId === "all" ? "" : departmentId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All departments</SelectItem>{departments.map(department => <SelectItem key={department.id} value={String(department.id)}>{department.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="flex gap-2 sm:col-span-2"><Button type="button" disabled={busy || !draft.title.trim() || !draft.instruction.trim()} onClick={save}>{editingId ? "Save template" : "Create template"}</Button>{editingId && <Button type="button" variant="outline" onClick={() => { setEditingId(null); setDraft(emptyActionTemplate); }}>Cancel</Button>}</div>
        </div>
        {loading ? <p className="text-sm text-muted-foreground">Loading templates…</p> : templates.length === 0 ? <p className="text-sm text-muted-foreground">No required-action templates yet.</p> : <div className="divide-y rounded-lg border">{[...templates].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((template, index, list) => <div key={template.id} className="flex items-start gap-3 p-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{template.title}</p><span className={`text-xs ${template.active ?? true ? "text-emerald-700" : "text-muted-foreground"}`}>{template.active ?? true ? "Enabled" : "Disabled"}</span></div><p className="mt-1 text-xs text-muted-foreground">{template.module ? TRACK_SUMMARY_MODULES.find(item => item.key === template.module)?.label ?? template.module : "All modules"} · {template.severity.replace("_", " ")} · {template.ownerDefault || "No owner"} · {template.leadTimeDays ?? 0} day lead time</p>{template.instruction && <p className="mt-1 text-sm text-muted-foreground">Instruction: {template.instruction}</p>}</div><div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={busy || index === 0} onClick={() => move(template, -1)}>↑</Button><Button size="sm" variant="ghost" disabled={busy || index === list.length - 1} onClick={() => move(template, 1)}>↓</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => beginEdit(template)}>Edit</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => patchTemplate(template, { active: !(template.active ?? true) })}>{template.active ?? true ? "Disable" : "Enable"}</Button></div></div>)}</div>}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetSettings();
  const { updateSettings, triggerTestEmail } = useAppMutations();
  const { user, billingLocked } = useAuth();
  const canAdmin = useCanAdmin();

  // Guide is shown once to paying client admins — hidden permanently after dismiss
  // or auto-hidden once both domain and From address are configured.
  const [guideDismissedLocally, setGuideDismissedLocally] = useState(false);
  const serverDismissed = (settings as any)?.emailSetupGuideDismissed === "true";
  const showEmailGuide =
    canAdmin &&
    user?.role === "client_admin" && // exclude consultants
    !billingLocked &&
    !serverDismissed &&
    !guideDismissedLocally;

  const handleDismissGuide = async () => {
    setGuideDismissedLocally(true); // immediate hide
    try {
      await apiFetch<void>("/settings", {
        method: "PUT",
        body: JSON.stringify({ emailSetupGuideDismissed: "true" }),
      });
    } catch { /* non-critical */ }
  };

  const [formData, setFormData] = useState({
    companyName: "",
    defaultLeadTimeDays: "30",
    contractorComplianceLeadTimeDays: "30",
    notificationEmail: "",
    maintenanceEmail: "",
    additionalReminderEmails: "",
    notifyClientAdmins: "false",
    safeTrackReminderFrequency: "daily",
    safeTrackReminderTime: "08:50",
    smtpFrom: "",
    smtpFromName: "",
    resendApiKey: "",
    accountTimezone: "Europe/London",
  });

  const [testEmail, setTestEmail] = useState("");
  const [trackSummaryRouting, setTrackSummaryRouting] = useState("");

  useEffect(() => {
    if (settings) {
      setFormData({
        companyName: settings.companyName || "",
        defaultLeadTimeDays: settings.defaultLeadTimeDays || "30",
        contractorComplianceLeadTimeDays: (settings as any).contractorComplianceLeadTimeDays || "30",
        notificationEmail: (settings as any).notificationEmail || "",
        maintenanceEmail: (settings as any).maintenanceEmail || "",
        additionalReminderEmails: (settings as any).additionalReminderEmails || "",
        notifyClientAdmins: (settings as any).notifyClientAdmins || "false",
        safeTrackReminderFrequency: (settings as any).safeTrackReminderFrequency || "daily",
        safeTrackReminderTime: (settings as any).safeTrackReminderTime || "08:50",
        smtpFrom: settings.smtpFrom || "",
        smtpFromName: settings.smtpFromName || "",
        resendApiKey: (settings as any).resendApiKey || "",
        accountTimezone: settings.accountTimezone || "Europe/London",
      });
      setTrackSummaryRouting((settings as any).trackSummaryRouting || "");
    }
  }, [settings]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateSettings.mutateAsync({ data: formData });
  };

  const handleTestEmail = async () => {
    if (!testEmail) return;
    await triggerTestEmail.mutateAsync({ data: { to: testEmail } });
  };

  if (isLoading) return <AppLayout title="Settings"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mt-10" /></AppLayout>;

  return (
    <AppLayout title="System Settings">
      <div className="max-w-4xl space-y-6">
        <BillingCard />
        <InvoicesCard />
        {canAdmin && <StorageUsageCard />}
        <DataExportCard />
        <DepartmentsCard />
        {canAdmin && <RequiredActionTemplatesCard />}
        <TrackSummaryRoutingCard
          value={trackSummaryRouting}
          seniorEmail={formData.notificationEmail}
          onSaved={setTrackSummaryRouting}
        />
        <PhotoRequirementsCard />
        <form onSubmit={handleSave}>
          <Card className="shadow-lg border-border/50 bg-card mb-6">
            <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
              <div className="flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-primary" />
                <CardTitle className="font-display">General Preferences</CardTitle>
              </div>
              <CardDescription>Global configuration for the compliance tracker.</CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>Company Name</Label>
                  <Input name="companyName" value={formData.companyName} onChange={handleChange} placeholder="Acme Corp" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>Default Reminder Lead Time (Days)</Label>
                  <p className="text-xs text-muted-foreground">Reminders sent this many days before a check is due. Default: 30 days.</p>
                  <Input type="number" name="defaultLeadTimeDays" value={formData.defaultLeadTimeDays} onChange={handleChange} />
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label>Account Timezone</Label>
                  <p className="text-xs text-muted-foreground">
                    Used for daily entry dates and the staff correction cutoff. Enter an IANA timezone such as Europe/London or America/New_York. Existing accounts default to Europe/London.
                  </p>
                  <Input
                    name="accountTimezone"
                    value={formData.accountTimezone}
                    onChange={handleChange}
                    placeholder="Europe/London"
                    autoComplete="off"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-lg border-border/50 bg-card mb-6">
            <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
              <div className="flex items-center gap-2">
                <Bell className="w-5 h-5 text-amber-500" />
                <CardTitle className="font-display">Reminder Notifications</CardTitle>
              </div>
              <CardDescription>
                Reminders are sent automatically to contractors every day at 8am when a compliance check enters its lead-time window.
                You can also copy in a maintenance contact on every reminder email.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-5">
              <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
                <div>
                  <Label>SafeTrack acknowledgement reminders</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Choose how often account admins and staff are reminded about outstanding SafeTrack sign-offs.
                    The delivery time uses your account timezone.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="safeTrackReminderFrequency">Frequency</Label>
                    <Select
                      value={formData.safeTrackReminderFrequency}
                      onValueChange={(value) =>
                        setFormData((prev) => ({ ...prev, safeTrackReminderFrequency: value }))
                      }
                    >
                      <SelectTrigger id="safeTrackReminderFrequency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">Every day</SelectItem>
                        <SelectItem value="weekly">Once a week</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="safeTrackReminderTime">Preferred delivery time</Label>
                    <Input
                      id="safeTrackReminderTime"
                      type="time"
                      name="safeTrackReminderTime"
                      value={formData.safeTrackReminderTime}
                      onChange={handleChange}
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Admin / Owner Notification Email</Label>
                <p className="text-xs text-muted-foreground">
                  All compliance alert emails (overdue checks, unacknowledged documents, expiring contractor insurance, training certificates)
                  will be sent to this address. If left blank, alerts go to each admin user on your account instead.
                </p>
                <Input
                  type="email"
                  name="notificationEmail"
                  value={formData.notificationEmail}
                  onChange={handleChange}
                  placeholder="owner@yourcompany.com"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Contractor expiry warning lead time (days)</Label>
                <p className="text-xs text-muted-foreground">
                  Send insurance, DBS / PVG, and certificate warnings this many days before expiry. Existing accounts use 30 days.
                </p>
                <Input
                  type="number"
                  name="contractorComplianceLeadTimeDays"
                  min="0"
                  max="365"
                  step="1"
                  value={formData.contractorComplianceLeadTimeDays}
                  onChange={handleChange}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Maintenance / Office CC Emails</Label>
                <p className="text-xs text-muted-foreground">
                  These addresses will be copied on every contractor reminder email. Separate multiple addresses with a comma.
                </p>
                <Input
                  name="maintenanceEmail"
                  value={formData.maintenanceEmail}
                  onChange={handleChange}
                  placeholder="maintenance@yourcompany.com, office@yourcompany.com"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Additional Recipients</Label>
                <p className="text-xs text-muted-foreground">
                  Optional extra addresses to copy on reminders — useful for site managers, directors, or external auditors. Separate with commas, semicolons, or new lines.
                </p>
                <Textarea
                  name="additionalReminderEmails"
                  value={formData.additionalReminderEmails}
                  onChange={handleChange}
                  rows={2}
                  placeholder="director@yourcompany.com, sitemanager@yourcompany.com"
                />
              </div>

              <label className="flex items-start gap-2.5 rounded-md border border-border bg-muted/30 p-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                  checked={formData.notifyClientAdmins === "true"}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, notifyClientAdmins: e.target.checked ? "true" : "false" }))
                  }
                />
                <span className="text-sm">
                  <span className="font-medium">Always copy account admins on every reminder</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    When ticked, every reminder email is automatically copied to the email address of every active admin user on this account — including yours when you trigger a manual send.
                  </span>
                </span>
              </label>
            </CardContent>
          </Card>

          {showEmailGuide && (
            <EmailSetupGuide
              settings={(settings as any) ?? {}}
              onDismiss={handleDismissGuide}
            />
          )}

          <div id="email-sender-section">
            <SenderDomainCard />
          </div>

          <div id="email-settings-section">
          <Card className="shadow-lg border-border/50 bg-card">
            <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-indigo-500" />
                <CardTitle className="font-display">Email Settings</CardTitle>
              </div>
              <CardDescription>
                Choose the sender name and email address your recipients will see. We handle delivery for you.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
                <Mail className="w-4 h-4 text-blue-600 flex-shrink-0" />
                Add your sender details below, then send a test email to confirm everything is working.
              </div>
              <div className="grid grid-cols-2 gap-6 pt-2">
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>Sender email address</Label>
                  <p className="text-xs text-muted-foreground">This is the address contractors and staff will see.</p>
                  <Input name="smtpFrom" value={formData.smtpFrom} onChange={handleChange} placeholder="compliance@yourcompany.com" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>Sender name</Label>
                  <Input name="smtpFromName" value={formData.smtpFromName} onChange={handleChange} placeholder="Acme Compliance Team" />
                </div>
              </div>

              <details className="pt-2 border-t border-border/50 mt-2">
                <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                  Advanced email settings
                </summary>
                <div className="space-y-1.5 pt-3">
                  <Label>Use your own email provider account</Label>
                  <p className="text-xs text-muted-foreground">
                    Most clients can leave this blank. Only use this if your administrator has asked you to connect a separate email account.
                  </p>
                  <Input
                    name="resendApiKey"
                    type="password"
                    autoComplete="off"
                    value={formData.resendApiKey}
                    onChange={handleChange}
                    placeholder="Optional provider key"
                  />
                </div>
              </details>
            </CardContent>
            <CardFooter className="bg-muted/10 border-t border-border/50 p-6 flex justify-between items-center">
              <div className="flex items-center gap-3">
                <Input
                  placeholder="Send a test to…"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="w-64"
                />
                <Button type="button" variant="secondary" onClick={handleTestEmail} disabled={triggerTestEmail.isPending || !testEmail}>
                  <Send className="w-4 h-4 mr-2" /> {triggerTestEmail.isPending ? "Sending..." : "Send test email"}
                </Button>
              </div>
              <Button type="submit" disabled={updateSettings.isPending} className="shadow-lg shadow-primary/20">
                {updateSettings.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </CardFooter>
          </Card>
          </div>
        </form>

        {/* Two-Factor Authentication */}
        <TwoFactorCard />
        <PasskeyCard />
      </div>
    </AppLayout>
  );
}

// ── Two-Factor Authentication card ───────────────────────────────────────────
function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const { toast } = useToast();

  type SetupStep = "idle" | "loading-qr" | "scanning" | "verifying" | "regenerating";
  const [step, setStep] = useState<SetupStep>("idle");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [regeneratePassword, setRegeneratePassword] = useState("");

  const enabled = user?.totpEnabled ?? false;

  async function startSetup() {
    setError("");
    setStep("loading-qr");
    try {
      const data = await apiFetch<{ qrDataUrl: string; secret: string }>("/auth/2fa/setup");
      setQrDataUrl(data.qrDataUrl);
      setSecret(data.secret);
      setStep("scanning");
    } catch (e: any) {
      setError(e.message ?? "Failed to start setup");
      setStep("idle");
    }
  }

  async function handleEnable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setStep("verifying");
    try {
      const result = await apiFetch<{ ok: boolean; recoveryCodes: string[] }>("/auth/2fa/enable", { method: "POST", body: JSON.stringify({ code: code.replace(/\s/g, "") }) });
      await refresh();
      setRecoveryCodes(result.recoveryCodes);
      toast({ title: "Two-factor authentication enabled" });
      setStep("idle");
      setCode("");
      setQrDataUrl(null);
      setSecret(null);
    } catch (e: any) {
      setError(e.message ?? "Verification failed");
      setCode("");
      setStep("scanning");
    }
  }

  async function handleRegenerate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const result = await apiFetch<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes/regenerate", {
        method: "POST",
        body: JSON.stringify({ password: regeneratePassword }),
      });
      setRecoveryCodes(result.recoveryCodes);
      setRegeneratePassword("");
      setStep("idle");
      toast({ title: "Recovery codes regenerated", description: "Your previous recovery codes no longer work." });
    } catch (e: any) {
      setError(e.message ?? "Failed to regenerate recovery codes");
    }
  }

  function downloadRecoveryCodes() {
    const content = `ComplyTrack recovery codes\n\n${recoveryCodes.join("\n")}\n\nEach code can be used once. Store these somewhere safe.`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "complytrack-recovery-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="shadow-lg border-border/50 bg-card mb-6">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <CardTitle className="font-display text-lg flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          Add an extra layer of security to your account. Once enabled, you'll need a code from your authenticator app every time you sign in.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        {enabled ? (
          <div className="space-y-4">
            {recoveryCodes.length > 0 && (
              <div className="px-4 py-3 rounded-sm bg-amber-50 border border-amber-300 text-amber-900 text-sm space-y-2">
                <p className="font-semibold">Save your recovery codes</p>
                <p>
                  Each code can be used once if you lose access to your authenticator app. Store them
                  somewhere safe — they will not be shown again after you close this screen.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 bg-white border border-amber-200 rounded-sm p-3">
                  {recoveryCodes.map((recoveryCode) => (
                    <code key={recoveryCode} className="font-mono text-sm tracking-wider select-all">{recoveryCode}</code>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="rounded-sm" onClick={downloadRecoveryCodes}>
                    <Download className="w-4 h-4 mr-1.5" /> Download codes
                  </Button>
                  <Button size="sm" variant="outline" className="rounded-sm" onClick={() => window.print()}>
                    Print codes
                  </Button>
                  <Button size="sm" className="rounded-sm" onClick={() => setRecoveryCodes([])}>
                    I've saved my codes
                  </Button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 px-4 py-3 rounded-sm bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">
              <ShieldCheck className="w-4 h-4 flex-shrink-0" />
              <span>Two-factor authentication is <strong>active</strong> on your account.</span>
            </div>
            {step === "idle" && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="rounded-sm gap-2" onClick={() => { setError(""); setStep("regenerating"); }}>
                  <KeyRound className="w-4 h-4" /> View / regenerate recovery codes
                </Button>
                <p className="text-xs text-muted-foreground">Two-factor authentication is required for all ComplyTrack user accounts. Contact an administrator if you lose access to your authenticator.</p>
              </div>
            )}
            {step === "regenerating" && (
              <form onSubmit={handleRegenerate} className="space-y-3 max-w-sm">
                <p className="text-sm text-muted-foreground">For security, existing codes cannot be viewed. Enter your password to replace them with 10 new codes.</p>
                <Input type="password" placeholder="Your password" value={regeneratePassword} onChange={e => setRegeneratePassword(e.target.value)} autoFocus className="rounded-sm" />
                {error && <p className="text-sm text-destructive">{error}</p>}
                <div className="flex gap-2">
                  <Button type="submit" className="rounded-sm" disabled={!regeneratePassword}>Regenerate codes</Button>
                  <Button type="button" variant="outline" className="rounded-sm" onClick={() => { setStep("idle"); setError(""); setRegeneratePassword(""); }}>Cancel</Button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 px-4 py-3 rounded-sm bg-amber-50 border border-amber-200 text-amber-800 text-sm">
              <ShieldOff className="w-4 h-4 flex-shrink-0" />
              <span>Two-factor authentication setup is required before using the application.</span>
            </div>

            {step === "idle" && (
              <Button className="rounded-sm gap-2" onClick={startSetup}>
                <ShieldCheck className="w-4 h-4" /> Enable two-factor authentication
              </Button>
            )}

            {step === "loading-qr" && (
              <p className="text-sm text-muted-foreground animate-pulse">Generating QR code…</p>
            )}

            {(step === "scanning" || step === "verifying") && qrDataUrl && (
              <div className="space-y-5 max-w-sm">
                <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>Install an authenticator app (Google Authenticator, Authy, 1Password, etc.)</li>
                  <li>Scan the QR code below or enter the key manually</li>
                  <li>Enter the 6-digit code shown in the app to confirm</li>
                </ol>
                <div className="flex flex-col items-center gap-3 p-4 bg-white border border-border rounded-sm">
                  <img src={qrDataUrl} alt="2FA QR code" className="w-48 h-48" />
                  {secret && (
                    <p className="text-xs text-muted-foreground text-center">
                      Manual key: <code className="font-mono bg-muted px-1 py-0.5 rounded text-foreground tracking-wider">{secret}</code>
                    </p>
                  )}
                </div>
                <form onSubmit={handleEnable} className="space-y-3">
                  <Label>Authentication code</Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    placeholder="000 000"
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/[^0-9\s]/g, "").slice(0, 7))}
                    autoFocus
                    autoComplete="one-time-code"
                    className="rounded-sm text-center text-lg tracking-[0.3em] font-mono"
                  />
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <div className="flex gap-2">
                    <Button type="submit" className="rounded-sm" disabled={code.replace(/\s/g, "").length < 6 || step === "verifying"}>
                      {step === "verifying" ? "Verifying…" : "Confirm & Enable"}
                    </Button>
                    <Button type="button" variant="outline" className="rounded-sm" onClick={() => { setStep("idle"); setCode(""); setError(""); setQrDataUrl(null); setSecret(null); }}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PasskeyCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [passkeys, setPasskeys] = useState<Array<{ id: number; deviceType: string | null; backedUp: boolean; createdAt: string; lastUsedAt: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await apiFetch<{ passkeys: typeof passkeys }>("/auth/passkeys");
      setPasskeys(data.passkeys);
    } catch (e: any) {
      setError(e.message ?? "Could not load passkeys");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function addPasskey() {
    setError("");
    setSaving(true);
    try {
      const options = await apiFetch("/auth/passkeys/registration/options", { method: "POST", body: "{}" });
      const response = await startRegistration({ optionsJSON: options });
      await apiFetch("/auth/passkeys/registration/verify", { method: "POST", body: JSON.stringify(response) });
      await load();
      toast({ title: "Passkey added", description: "You can now use it when signing in." });
    } catch (e: any) {
      setError(e.message ?? "Passkey registration failed");
    } finally {
      setSaving(false);
    }
  }

  async function removePasskey(id: number) {
    setError("");
    try {
      await apiFetch(`/auth/passkeys/${id}`, { method: "DELETE" });
      setPasskeys(current => current.filter(passkey => passkey.id !== id));
      toast({ title: "Passkey removed" });
    } catch (e: any) {
      setError(e.message ?? "Could not remove passkey");
    }
  }

  return (
    <Card className="shadow-lg border-border/50 bg-card mb-6">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <CardTitle className="font-display text-lg flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> Passkeys
        </CardTitle>
        <CardDescription>
          Sign in with Face ID, Touch ID, your device PIN, or a security key instead of typing a one-time code.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading passkeys…</p>
        ) : passkeys.length > 0 ? (
          <div className="space-y-2">
            {passkeys.map(passkey => (
              <div key={passkey.id} className="flex items-center justify-between gap-3 rounded-sm border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{passkey.deviceType === "singleDevice" ? "This device" : "Passkey"}</p>
                  <p className="text-xs text-muted-foreground">Added {new Date(passkey.createdAt).toLocaleDateString()}</p>
                </div>
                <Button type="button" variant="outline" size="sm" className="rounded-sm" onClick={() => removePasskey(passkey.id)}>
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Remove
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No passkeys are registered yet.</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="button" variant="outline" className="rounded-sm gap-2" onClick={addPasskey} disabled={saving}>
          <KeyRound className="w-4 h-4" /> {saving ? "Waiting for passkey…" : "Add a passkey"}
        </Button>
      </CardContent>
    </Card>
  );
}

const MODULES = [
  {
    id: "safetrack" as const,
    label: "SafeTrack",
    description: "Compliance item tracking, contractor reminders, fire & water safety summaries.",
    Icon: ShieldCheck,
  },
  {
    id: "dailytrack" as const,
    label: "DailyTrack",
    description: "Daily opening & closing checklists for all sites, with sign-off and history archive.",
    Icon: ClipboardCheck,
  },
];

function ModulesCard() {
  const { toast } = useToast();
  const [modules, setModules] = useState<ModuleState | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ModuleState>("/billing/modules")
      .then(setModules)
      .catch(() => setModules(null))
      .finally(() => setLoading(false));
  }, []);

  const toggle = async (id: "safetrack" | "dailytrack", currentlyEnabled: boolean) => {
    setToggling(id);
    try {
      const updated = await apiFetch<ModuleState>(`/billing/modules/${id}`, {
        method: "POST",
        body: JSON.stringify({ enabled: !currentlyEnabled }),
      });
      setModules(updated);
      toast({ title: `${id === "safetrack" ? "SafeTrack" : "DailyTrack"} ${!currentlyEnabled ? "activated" : "deactivated"}` });
    } catch (err: any) {
      toast({ title: "Failed to update module", description: err.message, variant: "destructive" });
    } finally {
      setToggling(null);
    }
  };

  return (
    <Card className="shadow-lg border-border/50 bg-card mb-6">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <Package className="w-5 h-5 text-primary" />
          <CardTitle className="font-display">Modules</CardTitle>
        </div>
        <CardDescription>
          Activate or deactivate product modules for your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6">
        {loading ? (
          <div className="py-4 flex justify-center"><div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : (
          <div className="space-y-3">
            {MODULES.map(({ id, label, description, Icon }) => {
              const enabled = modules?.[id]?.enabled ?? false;
              const busy = toggling === id;
              return (
                <div key={id} className={`flex items-start gap-4 rounded-xl border p-4 transition-colors ${enabled ? "border-emerald-200 bg-emerald-50/40" : "border-border bg-muted/20"}`}>
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${enabled ? "bg-emerald-100" : "bg-muted"}`}>
                    <Icon className={`w-5 h-5 ${enabled ? "text-emerald-600" : "text-muted-foreground"}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{label}</span>
                      {enabled && (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium bg-emerald-100 border border-emerald-200 rounded-full px-2 py-0.5">
                          <CheckCircle2 className="w-3 h-3" /> Active
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                  </div>
                  <Button
                    variant={enabled ? "outline" : "default"}
                    size="sm"
                    className="flex-shrink-0"
                    disabled={busy}
                    onClick={() => toggle(id, enabled)}
                  >
                    {busy ? "…" : enabled ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
