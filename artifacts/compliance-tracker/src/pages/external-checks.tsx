import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { AppLayout } from "@/components/layout";
import { useListComplianceItems, useSendReminderForItem, useListSites } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppMutations } from "@/hooks/use-app-data";
import { toast } from "sonner";
import { StatusBadge, PriorityBadge } from "@/components/badges";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { format } from "date-fns";
import { Plus, Briefcase, Mail, Send, Calendar, X, Building2, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, 
  DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent
} from "@/components/ui/dropdown-menu";
import { Card } from "@/components/ui/card";

type FilterKey =
  | "due-soon"
  | "action-needed"
  | "overdue"
  | "expired-certs"
  | "status-pending"
  | "status-in_progress"
  | "status-completed";

const FILTER_LABELS: Record<FilterKey, { label: string; description: string }> = {
  "due-soon": { label: "Due in next 30 days", description: "Compliance checks with a due date in the next 30 days." },
  "action-needed": { label: "Action needed", description: "Overdue checks and any critical-priority checks that aren't yet completed." },
  "overdue": { label: "Overdue", description: "Checks past their due date or marked overdue." },
  "expired-certs": { label: "Expired certificates", description: "Checks whose latest related contractor certificate is past its expiry date." },
  "status-pending": { label: "Pending", description: "Checks waiting to be started." },
  "status-in_progress": { label: "In progress", description: "Checks currently being worked on." },
  "status-completed": { label: "Completed", description: "Checks that have been completed." },
};

export default function ExternalChecksPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);

  const filterParam = useMemo(() => {
    const v = new URLSearchParams(search).get("filter");
    return (v && (v in FILTER_LABELS) ? (v as FilterKey) : null);
  }, [search]);

  const siteParam = useMemo(() => {
    const v = new URLSearchParams(search).get("siteId");
    return v ?? "all";
  }, [search]);

  const { data: rawItems = [], isLoading } = useListComplianceItems({});
  const { data: sites = [] } = useListSites();
  const queryClient = useQueryClient();
  const [loadingStarter, setLoadingStarter] = useState(false);

  const loadStarterPack = async () => {
    if (!confirm("Load the starter pack? This adds the standard H&S categories and around 27 example compliance checks (Gas, Fire, Electrical, LOLER, Legionella, Pressure Systems, HVAC). Everything is fully editable.")) return;
    setLoadingStarter(true);
    try {
      const res = await apiFetch("/starter-pack/load", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to load starter pack");
      }
      await queryClient.invalidateQueries();
      toast.success("Starter pack loaded — categories and example checks added.");
    } catch (err: any) {
      toast.error(err.message ?? "Couldn't load starter pack");
    } finally {
      setLoadingStarter(false);
    }
  };

  const setSiteFilter = (value: string) => {
    const params = new URLSearchParams(search);
    if (value === "all") params.delete("siteId");
    else params.set("siteId", value);
    const qs = params.toString();
    navigate(`/external-checks${qs ? `?${qs}` : ""}`);
  };

  const siteFilteredItems = useMemo(() => {
    if (siteParam === "all") return rawItems;
    if (siteParam === "none") return (rawItems as any[]).filter((i) => !i.siteId);
    const id = Number(siteParam);
    return (rawItems as any[]).filter((i) => i.siteId === id);
  }, [rawItems, siteParam]);

  const items = useMemo(() => {
    if (!filterParam) return siteFilteredItems;
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    return (siteFilteredItems as any[]).filter((i) => {
      switch (filterParam) {
        case "due-soon": {
          if (!i.dueDate || i.status === "completed") return false;
          const d = new Date(i.dueDate);
          return d >= now && d <= in30;
        }
        case "overdue":
          return i.status === "overdue" || (i.dueDate && new Date(i.dueDate) < now && i.status !== "completed");
        case "action-needed":
          return (
            i.status === "overdue" ||
            (i.priority === "critical" && i.status !== "completed") ||
            (i.dueDate && new Date(i.dueDate) < now && i.status !== "completed")
          );
        case "expired-certs":
          return i.latestCertExpiryDate && new Date(i.latestCertExpiryDate) < now;
        case "status-pending":
          return i.status === "pending";
        case "status-in_progress":
          return i.status === "in_progress";
        case "status-completed":
          return i.status === "completed";
        default:
          return true;
      }
    });
  }, [rawItems, filterParam]);

  // When a filter is active, group by site so it's easy to scan per location.
  const groupedBySite = useMemo(() => {
    if (!filterParam) return null;
    const map = new Map<string, { siteName: string; items: any[] }>();
    for (const it of items as any[]) {
      const key = it.siteName ?? "__unassigned__";
      if (!map.has(key)) map.set(key, { siteName: it.siteName ?? "No site assigned", items: [] });
      map.get(key)!.items.push(it);
    }
    return Array.from(map.values()).sort((a, b) => a.siteName.localeCompare(b.siteName));
  }, [items, filterParam]);
  const { deleteItem, updateItemStatus, triggerReminders } = useAppMutations();
  const sendOne = useSendReminderForItem({
    mutation: {
      onSuccess: (data: any) => toast.success(data?.message ?? "Reminder sent"),
      onError: (err: any) => toast.error(err?.message ?? "Failed to send reminder"),
    },
  });

  const selectedSiteName =
    siteParam === "all"
      ? null
      : siteParam === "none"
        ? "No site assigned"
        : (sites as any[]).find((s) => String(s.id) === siteParam)?.name ?? null;

  return (
    <AppLayout title="Compliance Checks">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <p className="text-muted-foreground">
          {filterParam ? FILTER_LABELS[filterParam].description : "All compliance checks across the business."}
          {selectedSiteName && <span className="ml-1">Site: <span className="font-semibold text-foreground">{selectedSiteName}</span>.</span>}
        </p>
        <div className="flex gap-3 w-full sm:w-auto items-center">
          <Select value={siteParam} onValueChange={setSiteFilter}>
            <SelectTrigger className="w-[180px] bg-card shadow-sm">
              <Building2 className="w-4 h-4 mr-2 text-muted-foreground" />
              <SelectValue placeholder="All sites" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {(sites as any[]).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
              <SelectItem value="none">No site assigned</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={loadStarterPack}
            disabled={loadingStarter}
            className="flex-1 sm:flex-none shadow-sm hover:shadow-md transition-shadow bg-card"
          >
            <Sparkles className="w-4 h-4 mr-2 text-amber-500" />
            {loadingStarter ? "Loading…" : "Load Starter Pack"}
          </Button>
          <Button 
            variant="secondary" 
            onClick={() => triggerReminders.mutate()} 
            disabled={triggerReminders.isPending}
            className="flex-1 sm:flex-none shadow-sm hover:shadow-md transition-shadow bg-card"
          >
            <Send className="w-4 h-4 mr-2 text-indigo-500" />
            {triggerReminders.isPending ? "Sending..." : "Send Reminders"}
          </Button>
          <Button 
            onClick={() => { setEditingItem(null); setIsFormOpen(true); }}
            className="flex-1 sm:flex-none shadow-lg shadow-primary/20"
          >
            <Plus className="w-4 h-4 mr-2" /> Add Check
          </Button>
        </div>
      </div>

      {filterParam && (
        <div className="mb-4 flex items-center gap-2 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
          <span className="text-xs text-muted-foreground">Filter:</span>
          <span className="text-sm font-semibold text-primary">{FILTER_LABELS[filterParam].label}</span>
          <span className="text-xs text-muted-foreground">· {items.length} match{items.length === 1 ? "" : "es"}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-xs"
            onClick={() => navigate("/external-checks")}
          >
            <X className="w-3 h-3 mr-1" /> Clear filter
          </Button>
        </div>
      )}

      {(() => {
        const renderRow = (item: any) => (
          <tr
            key={item.id}
            role="link"
            tabIndex={0}
            aria-label={`View details for ${item.title}`}
            className="bg-card hover:bg-muted/30 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
            onClick={() => navigate(`/items/${item.id}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                navigate(`/items/${item.id}`);
              }
            }}
          >
            <td className="px-6 py-4">
              <p className="font-semibold text-foreground hover:text-primary transition-colors">{item.title}</p>
              {(item.siteName || item.categoryName) && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {item.categoryName && (
                    <span className="text-xs px-2 py-0.5 rounded-md text-white inline-block" style={{ backgroundColor: item.categoryColor ?? "#6366f1" }}>
                      {item.categoryName}
                    </span>
                  )}
                  {!groupedBySite && item.siteName && (
                    <span className="text-xs px-2 py-0.5 rounded-md bg-secondary text-secondary-foreground inline-block border">{item.siteName}</span>
                  )}
                </div>
              )}
            </td>
            <td className="px-6 py-4">
              {item.contractorName ? (
                <div className="flex flex-col">
                  <span className="font-medium">{item.contractorName}</span>
                  <span className="text-xs text-muted-foreground flex items-center mt-0.5"><Mail className="w-3 h-3 mr-1" />{item.contractorEmail}</span>
                </div>
              ) : <span className="text-muted-foreground text-xs italic">Unassigned</span>}
            </td>
            <td className="px-6 py-4">
              <div className="flex flex-col gap-1.5 items-start">
                <StatusBadge status={item.status} />
                <PriorityBadge priority={item.priority} />
              </div>
            </td>
            <td className="px-6 py-4">
              {item.dueDate ? (
                <div className="flex flex-col">
                  <span className="font-medium">{format(new Date(item.dueDate), "MMM d, yyyy")}</span>
                  {item.leadTimeDays && <span className="text-xs text-muted-foreground flex items-center mt-0.5"><Calendar className="w-3 h-3 mr-1" /> Alert {item.leadTimeDays}d before</span>}
                  {filterParam === "expired-certs" && item.latestCertExpiryDate && (
                    <span className="text-xs text-red-600 mt-0.5">Cert expired {format(new Date(item.latestCertExpiryDate), "MMM d, yyyy")}</span>
                  )}
                </div>
              ) : (
                filterParam === "expired-certs" && item.latestCertExpiryDate ? (
                  <span className="text-xs text-red-600">Cert expired {format(new Date(item.latestCertExpiryDate), "MMM d, yyyy")}</span>
                ) : "-"
              )}
            </td>
            <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-8 w-8 p-0 border border-transparent hover:border-border">
                    <span className="sr-only">Open menu</span>
                    <div className="w-1 h-1 bg-foreground rounded-full mx-auto my-0.5"></div>
                    <div className="w-1 h-1 bg-foreground rounded-full mx-auto my-0.5"></div>
                    <div className="w-1 h-1 bg-foreground rounded-full mx-auto my-0.5"></div>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48 shadow-xl">
                  <DropdownMenuItem onClick={() => { setEditingItem(item); setIsFormOpen(true); }}>
                    Edit Details
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!item.contractorEmail || sendOne.isPending}
                    onClick={() => sendOne.mutate({ itemId: item.id })}
                  >
                    <Send className="w-3.5 h-3.5 mr-2 text-indigo-500" />
                    {sendOne.isPending && sendOne.variables?.itemId === item.id ? "Sending..." : "Send Reminder Now"}
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Update Status</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => updateItemStatus.mutate({ id: item.id, data: { status: "pending" }})}>Pending</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => updateItemStatus.mutate({ id: item.id, data: { status: "in_progress" }})}>In Progress</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => updateItemStatus.mutate({ id: item.id, data: { status: "completed" }})}>Completed</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => updateItemStatus.mutate({ id: item.id, data: { status: "overdue" }})}>Overdue</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:bg-destructive/10" onClick={() => deleteItem.mutate({ id: item.id })}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </td>
          </tr>
        );

        const tableHead = (
          <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border/50">
            <tr>
              <th className="px-6 py-4 font-semibold tracking-wider">Task</th>
              <th className="px-6 py-4 font-semibold tracking-wider">Contractor</th>
              <th className="px-6 py-4 font-semibold tracking-wider">Status</th>
              <th className="px-6 py-4 font-semibold tracking-wider">Due Date</th>
              <th className="px-6 py-4 font-semibold tracking-wider text-right">Actions</th>
            </tr>
          </thead>
        );

        if (isLoading) {
          return (
            <Card className="shadow-lg border-border/50 bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  {tableHead}
                  <tbody><tr><td colSpan={5} className="px-6 py-12 text-center">Loading...</td></tr></tbody>
                </table>
              </div>
            </Card>
          );
        }

        if (items.length === 0) {
          return (
            <Card className="shadow-lg border-border/50 bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  {tableHead}
                  <tbody>
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                        <Briefcase className="w-8 h-8 mx-auto mb-3 opacity-20" />
                        {filterParam ? "Nothing matches this filter — you're all caught up." : "No external checks found."}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          );
        }

        if (groupedBySite) {
          return (
            <div className="space-y-5">
              {groupedBySite.map((group) => (
                <Card key={group.siteName} className="shadow-lg border-border/50 bg-card overflow-hidden">
                  <div className="flex items-center gap-2 px-6 py-3 bg-muted/40 border-b border-border/50">
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <h3 className="font-display text-sm font-bold">{group.siteName}</h3>
                    <span className="text-xs text-muted-foreground ml-1">· {group.items.length} check{group.items.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      {tableHead}
                      <tbody className="divide-y divide-border/50">
                        {group.items.map(renderRow)}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ))}
            </div>
          );
        }

        return (
          <Card className="shadow-lg border-border/50 bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                {tableHead}
                <tbody className="divide-y divide-border/50">
                  {items.map(renderRow)}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })()}

      <ItemFormDialog 
        isOpen={isFormOpen} 
        onClose={() => setIsFormOpen(false)} 
        item={editingItem}
      />
    </AppLayout>
  );
}
