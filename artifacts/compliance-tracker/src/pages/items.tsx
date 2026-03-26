import { useState } from "react";
import { AppLayout } from "@/components/layout";
import { useListComplianceItems, useListCategories, ComplianceItem } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { StatusBadge, PriorityBadge } from "@/components/badges";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { format } from "date-fns";
import { 
  Plus, Search, Filter, MoreHorizontal, Pencil, Trash2, 
  CheckCircle, Clock, AlertCircle 
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, 
  DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, 
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

export default function ItemsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ComplianceItem | null>(null);
  
  const [itemToDelete, setItemToDelete] = useState<number | null>(null);
  const { deleteItem, updateItemStatus } = useAppMutations();
  const { toast } = useToast();

  const { data: items, isLoading } = useListComplianceItems({
    status: statusFilter as any || undefined,
    priority: priorityFilter as any || undefined,
    categoryId: categoryFilter ? parseInt(categoryFilter) : undefined
  });

  const { data: categories } = useListCategories();

  const handleEdit = (item: ComplianceItem) => {
    setEditingItem(item);
    setIsFormOpen(true);
  };

  const handleDelete = async () => {
    if (!itemToDelete) return;
    try {
      await deleteItem.mutateAsync({ id: itemToDelete });
      toast({ title: "Item deleted successfully" });
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally {
      setItemToDelete(null);
    }
  };

  const handleStatusChange = async (id: number, status: string) => {
    try {
      await updateItemStatus.mutateAsync({ id, data: { status: status as any } });
      toast({ title: "Status updated" });
    } catch (err: any) {
      toast({ title: "Failed to update", variant: "destructive" });
    }
  };

  return (
    <AppLayout title="Compliance Items">
      
      {/* Action Bar */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center mb-6 bg-card p-4 rounded-2xl shadow-sm border border-border">
        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
          <div className="relative">
            <Filter className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <select 
              value={statusFilter} 
              onChange={(e) => setStatusFilter(e.target.value)}
              className="pl-9 pr-8 py-2 rounded-xl text-sm border-0 bg-muted/50 focus:ring-2 focus:ring-primary/20 outline-none appearance-none font-medium text-foreground"
            >
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="overdue">Overdue</option>
            </select>
          </div>
          
          <div className="relative">
            <select 
              value={priorityFilter} 
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="px-4 pr-8 py-2 rounded-xl text-sm border-0 bg-muted/50 focus:ring-2 focus:ring-primary/20 outline-none appearance-none font-medium text-foreground"
            >
              <option value="">All Priorities</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          <div className="relative">
            <select 
              value={categoryFilter} 
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-4 pr-8 py-2 rounded-xl text-sm border-0 bg-muted/50 focus:ring-2 focus:ring-primary/20 outline-none appearance-none font-medium text-foreground max-w-[150px] truncate"
            >
              <option value="">All Categories</option>
              {categories?.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        <Button 
          onClick={() => { setEditingItem(null); setIsFormOpen(true); }}
          className="rounded-xl shadow-lg shadow-primary/20 hover:shadow-xl transition-all"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Item
        </Button>
      </div>

      {/* Table */}
      <div className="bg-card rounded-2xl shadow-sm border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-muted/30 border-b border-border">
              <tr>
                <th className="px-6 py-4 font-semibold tracking-wider">Title</th>
                <th className="px-6 py-4 font-semibold tracking-wider">Status</th>
                <th className="px-6 py-4 font-semibold tracking-wider">Priority</th>
                <th className="px-6 py-4 font-semibold tracking-wider">Category</th>
                <th className="px-6 py-4 font-semibold tracking-wider">Due Date</th>
                <th className="px-6 py-4 font-semibold tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <div className="inline-block w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
                  </td>
                </tr>
              ) : items?.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                    <div className="flex flex-col items-center">
                      <Search className="w-12 h-12 opacity-20 mb-3" />
                      <p className="text-base font-medium text-foreground">No compliance items found</p>
                      <p>Try adjusting your filters or create a new item.</p>
                    </div>
                  </td>
                </tr>
              ) : items?.map((item) => (
                <tr key={item.id} className="hover:bg-muted/20 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="font-semibold text-foreground">{item.title}</div>
                    {item.assignedTo && <div className="text-xs text-muted-foreground mt-1">Assignee: {item.assignedTo}</div>}
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="px-6 py-4">
                    <PriorityBadge priority={item.priority} />
                  </td>
                  <td className="px-6 py-4">
                    {item.categoryName ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-secondary text-secondary-foreground">
                        {item.categoryColor && (
                          <span className="w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: item.categoryColor }}></span>
                        )}
                        {item.categoryName}
                      </span>
                    ) : (
                      <span className="text-muted-foreground italic text-xs">None</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {item.dueDate ? (
                      <span className={new Date(item.dueDate) < new Date() && item.status !== 'completed' ? "text-rose-600 font-medium" : "text-muted-foreground"}>
                        {format(new Date(item.dueDate), "MMM d, yyyy")}
                      </span>
                    ) : "-"}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48 rounded-xl shadow-lg border-border">
                        <DropdownMenuItem onClick={() => handleEdit(item)} className="cursor-pointer font-medium">
                          <Pencil className="mr-2 w-4 h-4 text-muted-foreground" /> Edit Details
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="font-medium cursor-pointer">
                            <CheckCircle className="mr-2 w-4 h-4 text-muted-foreground" /> Change Status
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="rounded-xl">
                            <DropdownMenuItem onClick={() => handleStatusChange(item.id, "pending")} className="cursor-pointer">Pending</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleStatusChange(item.id, "in_progress")} className="cursor-pointer">In Progress</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleStatusChange(item.id, "completed")} className="cursor-pointer">Completed</DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem 
                          onClick={() => setItemToDelete(item.id)} 
                          className="text-destructive focus:bg-destructive/10 cursor-pointer font-medium"
                        >
                          <Trash2 className="mr-2 w-4 h-4" /> Delete Item
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ItemFormDialog 
        open={isFormOpen} 
        onOpenChange={setIsFormOpen} 
        item={editingItem} 
      />

      <AlertDialog open={!!itemToDelete} onOpenChange={() => setItemToDelete(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the compliance item.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded-xl">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </AppLayout>
  );
}
