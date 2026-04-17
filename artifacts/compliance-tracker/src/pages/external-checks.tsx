import { useState } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout";
import { useListComplianceItems, useSendReminderForItem } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { toast } from "sonner";
import { StatusBadge, PriorityBadge } from "@/components/badges";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { format } from "date-fns";
import { Plus, Briefcase, Mail, Send, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, 
  DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent
} from "@/components/ui/dropdown-menu";
import { Card } from "@/components/ui/card";

export default function ExternalChecksPage() {
  const [, navigate] = useLocation();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);

  const { data: items = [], isLoading } = useListComplianceItems({ type: "external" });
  const { deleteItem, updateItemStatus, triggerReminders } = useAppMutations();
  const sendOne = useSendReminderForItem({
    mutation: {
      onSuccess: (data: any) => toast.success(data?.message ?? "Reminder sent"),
      onError: (err: any) => toast.error(err?.message ?? "Failed to send reminder"),
    },
  });

  return (
    <AppLayout title="Compliance Checks">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <p className="text-muted-foreground">Compliance requirements managed by external contractors.</p>
        <div className="flex gap-3 w-full sm:w-auto">
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

      <Card className="shadow-lg border-border/50 bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border/50">
              <tr>
                <th className="px-6 py-4 font-semibold tracking-wider">Task</th>
                <th className="px-6 py-4 font-semibold tracking-wider">Contractor</th>
                <th className="px-6 py-4 font-semibold tracking-wider">Status</th>
                <th className="px-6 py-4 font-semibold tracking-wider">Due Date</th>
                <th className="px-6 py-4 font-semibold tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                <tr><td colSpan={5} className="px-6 py-12 text-center">Loading...</td></tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                    <Briefcase className="w-8 h-8 mx-auto mb-3 opacity-20" />
                    No external checks found.
                  </td>
                </tr>
              ) : (
                items.map((item) => (
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
                          {item.siteName && (
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
                        </div>
                      ) : "-"}
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <ItemFormDialog 
        isOpen={isFormOpen} 
        onClose={() => setIsFormOpen(false)} 
        item={editingItem}
      />
    </AppLayout>
  );
}
