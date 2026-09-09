import React, { useEffect, useState, useMemo } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { 
  CheckCircle2, Search, Building, MapPin,
  ChevronDown, ChevronRight, Loader2, Pencil, Send
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

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

export default function ContractorApprovalsPage() {
  const [items, setItems] = useState<EmailQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const { toast } = useToast();
  const [expandedSites, setExpandedSites] = useState<Set<string>>(new Set());
  
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editText, setEditText] = useState("");
  const [submittingId, setSubmittingId] = useState<number | null>(null);

  useEffect(() => {
    fetchItems();
  }, []);

  async function fetchItems() {
    setLoading(true);
    try {
      const res = await apiFetch("/fix-track/contractor-email-queue?status=pending");
      if (res.ok) {
        setItems(await res.json());
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
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

  async function handleApprove(id: number, modifiedPreview?: { subject: string; text: string }) {
    setSubmittingId(id);
    try {
      const endpoint = modifiedPreview ? "edit-and-send" : "approve-and-send";
      const payload = modifiedPreview
        ? { subject: modifiedPreview.subject, bodyText: modifiedPreview.text }
        : {};
      const res = await apiFetch(`/fix-track/contractor-email-queue/${id}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("Failed to approve email");
      toast({ title: "Email approved and sent" });
      setEditingId(null);
      setItems(prev => prev.filter(i => i.id !== id));
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSubmittingId(null);
    }
  }

  async function handleCancel(id: number) {
    if (!confirm("Are you sure you want to cancel this email request?")) return;
    setSubmittingId(id);
    try {
      const res = await apiFetch(`/fix-track/contractor-email-queue/${id}/cancel`, {
        method: "POST"
      });
      if (!res.ok) throw new Error("Failed to cancel email");
      toast({ title: "Email cancelled" });
      setItems(prev => prev.filter(i => i.id !== id));
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSubmittingId(null);
    }
  }

  function startEdit(item: EmailQueueItem) {
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

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 bg-card border rounded-lg text-muted-foreground">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm font-medium text-foreground">No pending emails</p>
            <p className="text-xs mt-1">All contractor emails have been reviewed.</p>
          </div>
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
                      const preview = item.emailPreviewJson || {};
                      
                      return (
                        <div key={item.id} className="p-4 flex flex-col gap-4">
                          <div className="flex items-start justify-between gap-4 flex-wrap">
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <span className={cn("text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border", 
                                  item.emailType === "quote_request" ? "bg-violet-50 text-violet-700 border-violet-200" : "bg-blue-50 text-blue-700 border-blue-200"
                                )}>
                                  {item.emailType === "quote_request" ? "Requesting Quote" : item.emailType === "reminder" ? "Reminder" : "Assigning Job"}
                                </span>
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
                                  onClick={() => handleCancel(item.id)}
                                  disabled={submittingId === item.id}
                                  className="h-8"
                                >
                                  Cancel
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
                                  onClick={() => handleApprove(item.id)}
                                  disabled={submittingId === item.id}
                                  className="h-8 bg-blue-600 hover:bg-blue-700 text-white"
                                >
                                  {submittingId === item.id ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                                  Approve & Send
                                </Button>
                              </div>
                            )}
                          </div>

                          <div className="bg-muted/30 border rounded-md p-3 text-sm font-mono whitespace-pre-wrap text-foreground/80">
                            {isEditing ? (
                              <div className="space-y-3 font-sans">
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
                                  <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => handleApprove(item.id, { subject: editSubject, text: editText })} disabled={submittingId === item.id}>
                                    {submittingId === item.id ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                                    Save & Send
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <>
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
      </div>
    </AppLayout>
  );
}
