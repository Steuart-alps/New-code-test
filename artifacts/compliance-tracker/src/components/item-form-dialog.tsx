import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { useAppMutations } from "@/hooks/use-app-data";
import { useListCategories, ComplianceItem } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const formSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "overdue"]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  categoryId: z.coerce.number().optional().nullable(),
  assignedTo: z.string().optional(),
  dueDate: z.string().optional().nullable(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface ItemFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: ComplianceItem | null;
}

export function ItemFormDialog({ open, onOpenChange, item }: ItemFormDialogProps) {
  const isEditing = !!item;
  const { createItem, updateItem } = useAppMutations();
  const { data: categories } = useListCategories();
  const { toast } = useToast();

  const { register, handleSubmit, formState: { errors, isSubmitting }, reset, setValue, watch } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      status: "pending",
      priority: "medium",
    }
  });

  useEffect(() => {
    if (item && open) {
      reset({
        title: item.title,
        description: item.description || "",
        status: item.status,
        priority: item.priority,
        categoryId: item.categoryId,
        assignedTo: item.assignedTo || "",
        dueDate: item.dueDate ? format(new Date(item.dueDate), "yyyy-MM-dd") : "",
        notes: item.notes || "",
      });
    } else if (!open) {
      reset({ status: "pending", priority: "medium", categoryId: null, title: "", description: "", assignedTo: "", dueDate: "", notes: "" });
    }
  }, [item, open, reset]);

  const onSubmit = async (data: FormValues) => {
    try {
      const payload = {
        ...data,
        categoryId: data.categoryId || null,
        dueDate: data.dueDate ? new Date(data.dueDate).toISOString() : null,
      };

      if (isEditing) {
        await updateItem.mutateAsync({ id: item.id, data: payload });
        toast({ title: "Item updated successfully" });
      } else {
        await createItem.mutateAsync({ data: payload });
        toast({ title: "Item created successfully" });
      }
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "An error occurred", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-2xl font-display">{isEditing ? "Edit Compliance Item" : "New Compliance Item"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="title">Title <span className="text-destructive">*</span></Label>
              <Input id="title" placeholder="e.g. Annual Security Audit" {...register("title")} className="bg-muted/50 focus:bg-background" />
              {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" placeholder="Details about this requirement..." {...register("description")} className="resize-none bg-muted/50 focus:bg-background h-20" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <select 
                id="status" 
                {...register("status")} 
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-muted/50 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:bg-background focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="overdue">Overdue</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <select 
                id="priority" 
                {...register("priority")} 
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-muted/50 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:bg-background focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="categoryId">Category</Label>
              <select 
                id="categoryId" 
                {...register("categoryId")} 
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-muted/50 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:bg-background focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="">No Category</option>
                {categories?.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dueDate">Due Date</Label>
              <Input id="dueDate" type="date" {...register("dueDate")} className="bg-muted/50 focus:bg-background" />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="assignedTo">Assigned To</Label>
              <Input id="assignedTo" placeholder="John Doe" {...register("assignedTo")} className="bg-muted/50 focus:bg-background" />
            </div>
            
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="notes">Internal Notes</Label>
              <Textarea id="notes" placeholder="Private notes..." {...register("notes")} className="resize-none bg-muted/50 focus:bg-background h-20" />
            </div>
          </div>

          <DialogFooter className="pt-4 border-t border-border">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting} className="min-w-[120px] shadow-lg shadow-primary/20">
              {isSubmitting ? "Saving..." : (isEditing ? "Save Changes" : "Create Item")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
