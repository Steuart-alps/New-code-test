import { useState } from "react";
import { AppLayout } from "@/components/layout";
import { useListComplianceItems } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { StatusBadge, PriorityBadge } from "@/components/badges";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { format } from "date-fns";
import { Plus, ListTodo, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, 
  DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent
} from "@/components/ui/dropdown-menu";
import { Card } from "@/components/ui/card";

export default function InternalChecksPage() {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);

  const { data: items = [], isLoading } = useListComplianceItems({ type: "internal" });
  const { deleteItem, updateItemStatus } = useAppMutations();

  return (
    <AppLayout title="Internal Checks">
      <div className="flex justify-between items-center mb-6">
        <p className="text-muted-foreground hidden sm:block">Compliance checks managed internally by your team.</p>
        <Button 
          onClick={() => { setEditingItem(null); setIsFormOpen(true); }}
          className="shadow-lg shadow-primary/20 w-full sm:w-auto"
        >
          <Plus className="w-4 h-4 mr-2" /> Add Check
        </Button>
      </div>

      <Card className="shadow-lg border-border/50 bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border/50">
              <tr>
                <th className="px-6 py-4 font-semibold tracking-wider">Task</th>
                <th className="px-6 py-4 font-semibold tracking-wider">Assignee</th>
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
                    <ListTodo className="w-8 h-8 mx-auto mb-3 opacity-20" />
                    No internal checks found.
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="bg-card hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-semibold text-foreground">{item.title}</p>
                      {item.categoryName && <span className="text-xs px-2 py-0.5 rounded-md bg-secondary text-secondary-foreground mt-1 inline-block border">{item.categoryName}</span>}
                    </td>
                    <td className="px-6 py-4">
                      {item.assignedTo ? (
                        <span className="font-medium flex items-center"><User className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />{item.assignedTo}</span>
                      ) : <span className="text-muted-foreground text-xs italic">Unassigned</span>}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1.5 items-start">
                        <StatusBadge status={item.status} />
                        <PriorityBadge priority={item.priority} />
                      </div>
                    </td>
                    <td className="px-6 py-4 font-medium">
                      {item.dueDate ? format(new Date(item.dueDate), "MMM d, yyyy") : "-"}
                    </td>
                    <td className="px-6 py-4 text-right">
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
        defaultType="internal"
      />
    </AppLayout>
  );
}
