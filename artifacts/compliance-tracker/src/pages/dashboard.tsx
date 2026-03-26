import { useGetDashboardStats, useListComplianceItems } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { FolderKanban, Activity, AlertCircle, Flame, Clock, CheckCircle2 } from "lucide-react";
import { motion } from "framer-motion";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { StatusBadge, PriorityBadge } from "@/components/badges";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: items, isLoading: itemsLoading } = useListComplianceItems({ priority: "critical" }); // Fetch critical items for quick view

  if (statsLoading) {
    return (
      <AppLayout title="Dashboard">
        <div className="flex h-64 items-center justify-center">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      </AppLayout>
    );
  }

  const statCards = [
    { title: "Total Items", value: stats?.total || 0, icon: FolderKanban, color: "text-blue-600", bg: "bg-blue-100 dark:bg-blue-900/30" },
    { title: "Completion Rate", value: `${Math.round(stats?.completionRate || 0)}%`, icon: Activity, color: "text-emerald-600", bg: "bg-emerald-100 dark:bg-emerald-900/30" },
    { title: "Overdue", value: stats?.overdue || 0, icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-100 dark:bg-rose-900/30", alert: (stats?.overdue || 0) > 0 },
    { title: "Critical Priority", value: stats?.criticalItems || 0, icon: Flame, color: "text-orange-600", bg: "bg-orange-100 dark:bg-orange-900/30" },
    { title: "Due Soon (7d)", value: stats?.dueSoon || 0, icon: Clock, color: "text-amber-600", bg: "bg-amber-100 dark:bg-amber-900/30" },
  ];

  const pieData = [
    { name: 'Pending', value: stats?.pending || 0, color: '#64748b' },
    { name: 'In Progress', value: stats?.inProgress || 0, color: '#3b82f6' },
    { name: 'Completed', value: stats?.completed || 0, color: '#10b981' },
    { name: 'Overdue', value: stats?.overdue || 0, color: '#f43f5e' },
  ].filter(d => d.value > 0);

  return (
    <AppLayout title="Overview">
      <div className="space-y-8">
        
        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {statCards.map((stat, i) => (
            <motion.div
              key={stat.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className={`relative overflow-hidden border-0 shadow-md ${stat.alert ? 'ring-2 ring-rose-500 ring-offset-2' : ''}`}>
                <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none transform translate-x-2 -translate-y-2">
                  <stat.icon className="w-16 h-16" />
                </div>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-xl ${stat.bg}`}>
                      <stat.icon className={`w-6 h-6 ${stat.color}`} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">{stat.title}</p>
                      <h3 className="text-2xl font-display font-bold text-foreground mt-1">{stat.value}</h3>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Chart Section */}
          <Card className="lg:col-span-2 shadow-md border-0">
            <div className="p-6 border-b border-border flex justify-between items-center">
              <div>
                <h3 className="text-lg font-display font-bold">Status Distribution</h3>
                <p className="text-sm text-muted-foreground">Current state of all compliance items</p>
              </div>
            </div>
            <CardContent className="p-6">
              <div className="h-[300px] w-full flex items-center justify-center">
                {pieData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={80}
                        outerRadius={110}
                        paddingAngle={5}
                        dataKey="value"
                        stroke="none"
                      >
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <RechartsTooltip 
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1)' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="text-muted-foreground flex flex-col items-center">
                    <CheckCircle2 className="w-12 h-12 mb-2 opacity-20" />
                    <p>No data to display</p>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap justify-center gap-6 mt-4">
                {pieData.map(d => (
                  <div key={d.name} className="flex items-center gap-2 text-sm font-medium">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: d.color }}></div>
                    <span>{d.name} <span className="text-muted-foreground ml-1">({d.value})</span></span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Critical Items Quick View */}
          <Card className="shadow-md border-0 flex flex-col">
            <div className="p-6 border-b border-border">
              <div className="flex items-center gap-2">
                <Flame className="w-5 h-5 text-orange-600" />
                <h3 className="text-lg font-display font-bold">Critical Action Items</h3>
              </div>
              <p className="text-sm text-muted-foreground mt-1">Requires immediate attention</p>
            </div>
            <CardContent className="p-0 flex-1 overflow-auto max-h-[350px]">
              {itemsLoading ? (
                <div className="p-6 flex justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div></div>
              ) : items && items.length > 0 ? (
                <div className="divide-y divide-border">
                  {items.map(item => (
                    <div key={item.id} className="p-4 hover:bg-muted/30 transition-colors">
                      <div className="flex justify-between items-start mb-2">
                        <h4 className="font-semibold text-sm truncate pr-4">{item.title}</h4>
                        <StatusBadge status={item.status} className="shrink-0" />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {item.dueDate && <span>Due: {new Date(item.dueDate).toLocaleDateString()}</span>}
                        {item.categoryName && <span className="px-1.5 py-0.5 rounded-md bg-secondary text-secondary-foreground">{item.categoryName}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
                  <CheckCircle2 className="w-12 h-12 mb-3 text-emerald-500 opacity-50" />
                  <p className="font-medium text-foreground">All clear!</p>
                  <p className="text-sm mt-1">No critical items pending.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
