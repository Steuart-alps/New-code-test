import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, AlertCircle, ArrowRightCircle } from "lucide-react";

type Status = "pending" | "in_progress" | "completed" | "overdue";
type Priority = "low" | "medium" | "high" | "critical";

export function StatusBadge({ status, className }: { status: Status | string; className?: string }) {
  const config: Record<string, { label: string; color: string; icon: any }> = {
    pending: { 
      label: "Pending", 
      color: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300", 
      icon: Clock 
    },
    in_progress: { 
      label: "In Progress", 
      color: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300", 
      icon: ArrowRightCircle 
    },
    completed: { 
      label: "Completed", 
      color: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300", 
      icon: CheckCircle2 
    },
    overdue: { 
      label: "Overdue", 
      color: "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300", 
      icon: AlertCircle 
    },
  };

  const safeStatus = config[status] ? status : "pending";
  const { label, color, icon: Icon } = config[safeStatus];

  return (
    <Badge variant="outline" className={cn("font-medium py-1 px-2.5 shadow-sm gap-1.5", color, className)}>
      <Icon className="w-3.5 h-3.5" />
      {label}
    </Badge>
  );
}

export function PriorityBadge({ priority, className }: { priority: Priority | string; className?: string }) {
  const config: Record<string, { label: string; dot: string; bg: string }> = {
    low: { label: "Low", dot: "bg-emerald-500", bg: "bg-emerald-50 text-emerald-700 border-emerald-100" },
    medium: { label: "Medium", dot: "bg-amber-500", bg: "bg-amber-50 text-amber-700 border-amber-100" },
    high: { label: "High", dot: "bg-orange-500", bg: "bg-orange-50 text-orange-700 border-orange-100" },
    critical: { label: "Critical", dot: "bg-rose-600 animate-pulse", bg: "bg-rose-50 text-rose-700 border-rose-100" },
  };

  const safePriority = config[priority] ? priority : "medium";
  const { label, dot, bg } = config[safePriority];

  return (
    <div className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border", bg, className)}>
      <div className={cn("w-2 h-2 rounded-full", dot)} />
      {label}
    </div>
  );
}

export function ExpiryBadge({ expiryDate }: { expiryDate: string | null | undefined }) {
  if (!expiryDate) return <Badge variant="secondary">No Expiry</Badge>;
  
  const daysUntil = Math.ceil((new Date(expiryDate).getTime() - new Date().getTime()) / (1000 * 3600 * 24));
  
  if (daysUntil < 0) {
    return <Badge variant="destructive">Expired</Badge>;
  }
  if (daysUntil <= 30) {
    return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-200 border-amber-200 shadow-none">Expiring Soon ({daysUntil}d)</Badge>;
  }
  return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-200 border-emerald-200 shadow-none">Valid</Badge>;
}
