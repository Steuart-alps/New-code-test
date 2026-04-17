import { useMemo } from "react";
import { Link, useRoute } from "wouter";
import { AppLayout } from "@/components/layout";
import { useGetSite, useListComplianceItems } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MapPin, Phone, User, Building2, AlertTriangle, Clock, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_META: Record<string, { label: string; icon: any; className: string }> = {
  overdue: { label: "Overdue", icon: AlertTriangle, className: "bg-rose-50 text-rose-700 border-rose-200" },
  in_progress: { label: "In Progress", icon: Loader2, className: "bg-amber-50 text-amber-700 border-amber-200" },
  pending: { label: "Pending", icon: Clock, className: "bg-slate-50 text-slate-700 border-slate-200" },
  completed: { label: "Completed", icon: CheckCircle2, className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

const PRIORITY_META: Record<string, string> = {
  critical: "bg-rose-100 text-rose-800 border-rose-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-blue-100 text-blue-800 border-blue-200",
  low: "bg-slate-100 text-slate-800 border-slate-200",
};

function formatDate(d: any): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return "—"; }
}

export default function SiteDetailPage() {
  const [, params] = useRoute("/sites/:id");
  const id = params ? Number(params.id) : NaN;
  const { data: site, isLoading, error } = useGetSite(id, { query: { enabled: Number.isFinite(id) } });
  const { data: allItems = [] } = useListComplianceItems();

  const siteItems = useMemo(() => {
    return allItems.filter(i => i.siteId === id)
      .sort((a, b) => {
        const order = { overdue: 0, in_progress: 1, pending: 2, completed: 3 };
        const ao = order[a.status as keyof typeof order] ?? 99;
        const bo = order[b.status as keyof typeof order] ?? 99;
        if (ao !== bo) return ao - bo;
        const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
        const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
        return ad - bd;
      });
  }, [allItems, id]);

  const counts = useMemo(() => {
    const c = { overdue: 0, in_progress: 0, pending: 0, completed: 0 };
    for (const item of siteItems) {
      if (item.status in c) c[item.status as keyof typeof c]++;
    }
    return c;
  }, [siteItems]);

  if (isLoading) {
    return <AppLayout title="Site"><div className="py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div></AppLayout>;
  }
  if (error || !site) {
    return <AppLayout title="Site"><div className="py-12 text-center text-muted-foreground">Site not found.</div></AppLayout>;
  }

  return (
    <AppLayout title={site.name}>
      <Link href="/sites" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Sites
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <Card className="p-6 lg:col-span-1 bg-card">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary/10 text-primary">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-xl">{site.name}</h2>
              <p className="text-xs text-muted-foreground">Site details</p>
            </div>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-3">
              <User className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground">Responsible Person</div>
                <div className="font-medium">{site.responsiblePerson || <span className="italic text-muted-foreground">Not set</span>}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <MapPin className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground">Site Address</div>
                <div className="font-medium whitespace-pre-line">{site.address || <span className="italic text-muted-foreground">Not set</span>}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground">Site Telephone</div>
                <div className="font-medium">{site.phone || <span className="italic text-muted-foreground">Not set</span>}</div>
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-6 lg:col-span-2 bg-card">
          <h3 className="font-display font-bold text-lg mb-4">Compliance Summary</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(["overdue", "in_progress", "pending", "completed"] as const).map(key => {
              const meta = STATUS_META[key];
              const Icon = meta.icon;
              return (
                <div key={key} className={cn("p-4 rounded-xl border", meta.className)}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <Icon className="w-4 h-4" />
                    <span className="text-xs font-semibold uppercase tracking-wider">{meta.label}</span>
                  </div>
                  <div className="text-2xl font-display font-bold">{counts[key]}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 text-sm text-muted-foreground">
            {siteItems.length} compliance check{siteItems.length === 1 ? "" : "s"} for this site
          </div>
        </Card>
      </div>

      <Card className="bg-card overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h3 className="font-display font-bold text-lg">Compliance Checks</h3>
          <Link href="/external">
            <Button variant="outline" size="sm">All Checks</Button>
          </Link>
        </div>
        {siteItems.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Circle className="w-8 h-8 mx-auto mb-3 opacity-20" />
            No compliance checks linked to this site yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {siteItems.map(item => {
              const meta = STATUS_META[item.status] ?? STATUS_META.pending;
              const Icon = meta.icon;
              return (
                <div key={item.id} className="px-6 py-4 flex items-start sm:items-center justify-between gap-4 flex-col sm:flex-row hover:bg-muted/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm">{item.title}</div>
                    {item.description && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.description}</div>}
                    <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <span>Due {formatDate(item.dueDate)}</span>
                      {item.contractorName && <span>· {item.contractorName}</span>}
                      {item.assignedTo && <span>· Assigned to {item.assignedTo}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.priority && (
                      <span className={cn("text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border", PRIORITY_META[item.priority] ?? PRIORITY_META.medium)}>
                        {item.priority}
                      </span>
                    )}
                    <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border", meta.className)}>
                      <Icon className="w-3 h-3" />
                      {meta.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
