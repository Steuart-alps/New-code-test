import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout";
import { useGetSettings } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Settings2, Mail, Send, Bell, CheckCircle2, Globe, RefreshCw, Trash2, Copy, AlertCircle, ExternalLink, CreditCard, Building2, FileText, Download, Users, Plus, X, ChevronDown, ChevronRight, Pencil, ShieldCheck, ShieldOff, KeyRound, Camera } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

// ── Local types used by DepartmentsCard ──────────────────────────────────────
interface Department { id: number; clientId: number; name: string; description?: string | null; createdAt: string; }
interface DeptUser { id: number; name: string; email: string; role: string; departmentId?: number | null; }
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

  const deleteDept = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}"? Users and sites assigned to it will become unassigned.`)) return;
    setBusy(true);
    try {
      await apiFetch(`/departments/${id}`, { method: "DELETE" });
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

  return (
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
                          onClick={() => deleteDept(dept.id, dept.name)}
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
          Send emails from your own verified domain (e.g. <code className="text-xs bg-muted px-1.5 py-0.5 rounded">noreply@yourcompany.co.uk</code>) instead of the default sender.
          You'll need access to your domain's DNS settings.{" "}
          <a
            href="https://resend.com/docs/dashboard/domains/introduction"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-primary hover:underline font-medium"
          >
            Domain setup guide <ExternalLink className="w-3 h-3" />
          </a>
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
              Enter the root domain (without <code>www</code> or <code>@</code>). After adding it you'll receive DNS records to copy into your domain provider.
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
                Add the records below to your domain's DNS settings, then click <strong>Check status</strong>. DNS changes can take up to 24 hours to propagate.
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
                Set the <em>From Email Address</em> below to anything ending in <strong>@{state.domainName}</strong> and emails will be sent from your domain.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface BillingConfig {
  subscription?: { status?: string } | null;
  siteCount: number;
  perSite: { priceId: string; unitAmount: number; currency: string } | null;
  billableQuantity: number;
  monthlyTotal: number | null;
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
  const { refresh: refreshAuth } = useAuth();
  const canAdmin = useCanAdmin();
  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
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
      <Card className="shadow-lg border-border/50 bg-card mb-6">
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
                <Button variant="outline" onClick={openPortal} disabled={busy}>
                  <ExternalLink className="w-4 h-4 mr-1.5" /> {busy ? "Opening…" : "Manage subscription"}
                </Button>
              </div>

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
                {servicesConfig.catalog.filter(c => c.key !== "core" && c.key !== "bundle").map(service => {
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

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetSettings();
  const { updateSettings, triggerTestEmail } = useAppMutations();

  const [formData, setFormData] = useState({
    companyName: "",
    defaultLeadTimeDays: "30",
    maintenanceEmail: "",
    additionalReminderEmails: "",
    notifyClientAdmins: "false",
    smtpFrom: "",
    smtpFromName: "",
    resendApiKey: "",
  });

  const [testEmail, setTestEmail] = useState("");

  useEffect(() => {
    if (settings) {
      setFormData({
        companyName: settings.companyName || "",
        defaultLeadTimeDays: settings.defaultLeadTimeDays || "30",
        maintenanceEmail: (settings as any).maintenanceEmail || "",
        additionalReminderEmails: (settings as any).additionalReminderEmails || "",
        notifyClientAdmins: (settings as any).notifyClientAdmins || "false",
        smtpFrom: settings.smtpFrom || "",
        smtpFromName: settings.smtpFromName || "",
        resendApiKey: (settings as any).resendApiKey || "",
      });
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
        <DepartmentsCard />
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

          <SenderDomainCard />

          <Card className="shadow-lg border-border/50 bg-card">
            <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-indigo-500" />
                <CardTitle className="font-display">Email Settings</CardTitle>
              </div>
              <CardDescription>
                Configure the sender name and address for outgoing emails. All emails are delivered via Resend.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700">
                <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                Resend is configured as your email provider. No additional credentials are required.
              </div>
              <div className="grid grid-cols-2 gap-6 pt-2">
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>From Email Address</Label>
                  <p className="text-xs text-muted-foreground">Must be a verified sender domain in your Resend account.</p>
                  <Input name="smtpFrom" value={formData.smtpFrom} onChange={handleChange} placeholder="compliance@yourcompany.com" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>From Name</Label>
                  <Input name="smtpFromName" value={formData.smtpFromName} onChange={handleChange} placeholder="Acme Compliance Team" />
                </div>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-border/50 mt-2">
                <Label>Your Own Resend API Key (optional)</Label>
                <p className="text-xs text-muted-foreground">
                  Leave blank to send through the shared ComplyTrack account. To send under your own Resend account
                  (your own billing, your own verified domain), paste an API key from{" "}
                  <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" className="underline">resend.com/api-keys</a>.
                  Stored privately and used only for emails from this account.
                </p>
                <Input
                  name="resendApiKey"
                  type="password"
                  autoComplete="off"
                  value={formData.resendApiKey}
                  onChange={handleChange}
                  placeholder="re_********************"
                />
              </div>
            </CardContent>
            <CardFooter className="bg-muted/10 border-t border-border/50 p-6 flex justify-between items-center">
              <div className="flex items-center gap-3">
                <Input
                  placeholder="Test recipient email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="w-64"
                />
                <Button type="button" variant="secondary" onClick={handleTestEmail} disabled={triggerTestEmail.isPending || !testEmail}>
                  <Send className="w-4 h-4 mr-2" /> {triggerTestEmail.isPending ? "Sending..." : "Send Test"}
                </Button>
              </div>
              <Button type="submit" disabled={updateSettings.isPending} className="shadow-lg shadow-primary/20">
                {updateSettings.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </CardFooter>
          </Card>
        </form>

        {/* Two-Factor Authentication */}
        <TwoFactorCard />
      </div>
    </AppLayout>
  );
}

// ── Two-Factor Authentication card ───────────────────────────────────────────
function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const { toast } = useToast();

  type SetupStep = "idle" | "loading-qr" | "scanning" | "verifying" | "disabling";
  const [step, setStep] = useState<SetupStep>("idle");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [error, setError] = useState("");

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
      await apiFetch("/auth/2fa/enable", { method: "POST", body: JSON.stringify({ code: code.replace(/\s/g, "") }) });
      await refresh();
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

  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setStep("disabling");
    try {
      await apiFetch("/auth/2fa/disable", { method: "POST", body: JSON.stringify({ password: disablePassword }) });
      await refresh();
      toast({ title: "Two-factor authentication disabled" });
      setStep("idle");
      setDisablePassword("");
    } catch (e: any) {
      setError(e.message ?? "Failed to disable 2FA");
      setStep("idle");
    }
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
            <div className="flex items-center gap-3 px-4 py-3 rounded-sm bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">
              <ShieldCheck className="w-4 h-4 flex-shrink-0" />
              <span>Two-factor authentication is <strong>active</strong> on your account.</span>
            </div>
            {step === "idle" && (
              <Button variant="outline" className="text-destructive hover:text-destructive hover:bg-destructive/10 rounded-sm gap-2" onClick={() => { setError(""); setStep("disabling"); }}>
                <ShieldOff className="w-4 h-4" /> Disable two-factor authentication
              </Button>
            )}
            {step === "disabling" && (
              <form onSubmit={handleDisable} className="space-y-3 max-w-sm">
                <p className="text-sm text-muted-foreground">Enter your password to confirm.</p>
                <Input
                  type="password"
                  placeholder="Your password"
                  value={disablePassword}
                  onChange={e => setDisablePassword(e.target.value)}
                  autoFocus
                  className="rounded-sm"
                />
                {error && <p className="text-sm text-destructive">{error}</p>}
                <div className="flex gap-2">
                  <Button type="submit" variant="destructive" className="rounded-sm" disabled={!disablePassword}>Disable 2FA</Button>
                  <Button type="button" variant="outline" className="rounded-sm" onClick={() => { setStep("idle"); setError(""); setDisablePassword(""); }}>Cancel</Button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 px-4 py-3 rounded-sm bg-amber-50 border border-amber-200 text-amber-800 text-sm">
              <ShieldOff className="w-4 h-4 flex-shrink-0" />
              <span>Two-factor authentication is <strong>not enabled</strong>.</span>
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
