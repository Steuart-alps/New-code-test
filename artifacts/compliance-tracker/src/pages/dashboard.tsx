import { useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { useGetDashboardStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from "recharts";
import { FileWarning, Clock, ShieldAlert, Building, Briefcase, Activity, Building2 } from "lucide-react";
import { useAuth, useIsConsultant } from "@/context/auth-context";
import { Link, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const { activeClientId } = useAuth();
  const isConsultant = useIsConsultant();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") === "success") {
      toast({ title: "Payment successful!", description: "Welcome to ComplyTrack. Your subscription is now active." });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  const { data: stats, isLoading } = useGetDashboardStats({ query: { enabled: !!activeClientId } });

  if (isConsultant && !activeClientId) {
    return (
      <AppLayout title="Overview">
        <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
          <div className="bg-primary/10 p-4 rounded-2xl">
            <Building2 className="w-10 h-10 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-1">No client selected</h2>
            <p className="text-muted-foreground text-sm mb-4">
              Go to the Clients page and click "View" on a client to see their dashboard.
            </p>
            <Link href="/clients">
              <span className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
                Go to Clients
              </span>
            </Link>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (isLoading || !stats) {
    return (
      <AppLayout title="Overview">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </AppLayout>
    );
  }

  const statusData = [
    { name: "Pending", value: stats.pending, color: "#94a3b8", filter: "status-pending" },
    { name: "In Progress", value: stats.inProgress, color: "#3b82f6", filter: "status-in_progress" },
    { name: "Completed", value: stats.completed, color: "#10b981", filter: "status-completed" },
    { name: "Overdue", value: stats.overdue, color: "#ef4444", filter: "overdue" },
  ];

  return (
    <AppLayout title="Overview">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Card className="shadow-lg shadow-black/5 border-border/50 bg-gradient-to-br from-card to-card/50">
          <CardContent className="p-6">
            <div className="flex justify-between items-start">
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Completion Rate</p>
                <p className="text-3xl font-display font-bold">{stats.completionRate}%</p>
              </div>
              <div className="p-3 bg-primary/10 rounded-xl">
                <Activity className="w-5 h-5 text-primary" />
              </div>
            </div>
            <div className="mt-4 h-2 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary" style={{ width: `${stats.completionRate}%` }} />
            </div>
          </CardContent>
        </Card>

        <Link href="/external-checks?filter=action-needed">
          <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl">
            <CardContent className="p-6">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Action Needed</p>
                  <p className="text-3xl font-display font-bold text-destructive">{stats.overdue + stats.criticalItems}</p>
                </div>
                <div className="p-3 bg-destructive/10 rounded-xl">
                  <ShieldAlert className="w-5 h-5 text-destructive" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                {stats.overdue} overdue, {stats.criticalItems} critical
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/external-checks?filter=due-soon">
          <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl">
            <CardContent className="p-6">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Due Soon (30d)</p>
                  <p className="text-3xl font-display font-bold text-amber-500">{stats.dueSoon}</p>
                </div>
                <div className="p-3 bg-amber-500/10 rounded-xl">
                  <Clock className="w-5 h-5 text-amber-500" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">Approaching deadlines</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/external-checks?filter=expired-certs">
          <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl">
            <CardContent className="p-6">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Expired Certs</p>
                  <p className="text-3xl font-display font-bold text-red-600">{(stats as any).certificatesExpired ?? 0}</p>
                </div>
                <div className="p-3 bg-red-600/10 rounded-xl">
                  <FileWarning className="w-5 h-5 text-red-600" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">Contractor certificates past expiry</p>
            </CardContent>
          </Card>
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 shadow-lg shadow-black/5 border-border/50">
          <CardHeader>
            <CardTitle className="text-lg font-display">Compliance Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statusData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                  <Tooltip 
                    cursor={{ fill: 'rgba(0,0,0,0.05)' }}
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }} 
                  />
                  <Bar
                    dataKey="value"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={60}
                    cursor="pointer"
                    onClick={(payload: any) => {
                      const f = payload?.payload?.filter ?? payload?.filter;
                      if (f) navigate(`/external-checks?filter=${f}`);
                    }}
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="shadow-lg shadow-black/5 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-display">Volume Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <Link
                  href="/external-checks"
                  className="flex items-center p-3 bg-muted/50 rounded-xl border border-border/50 hover:bg-muted hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                  aria-label="View all compliance checks"
                >
                  <div className="bg-emerald-500/20 p-2.5 rounded-lg mr-4">
                    <Briefcase className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold">Compliance Checks</h4>
                    <p className="text-xs text-muted-foreground">Contractor requirements</p>
                  </div>
                  <span className="text-xl font-display font-bold">{stats.total}</span>
                </Link>

                <Link
                  href="/contractors"
                  className="flex items-center p-3 bg-muted/50 rounded-xl border border-border/50 hover:bg-muted hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                  aria-label="View all contractors"
                >
                  <div className="bg-indigo-500/20 p-2.5 rounded-lg mr-4">
                    <Building className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold">Contractors</h4>
                    <p className="text-xs text-muted-foreground">Active in system</p>
                  </div>
                  <span className="text-xl font-display font-bold">{stats.contractorsCount}</span>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
