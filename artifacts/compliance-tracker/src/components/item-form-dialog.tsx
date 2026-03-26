import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter 
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { 
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue 
} from "@/components/ui/select";
import { useAppMutations } from "@/hooks/use-app-data";
import { ComplianceItem, ComplianceItemType, useListCategories, useListContractors } from "@workspace/api-client-react";

const formSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  type: z.enum(["internal", "external"]),
  status: z.enum(["pending", "in_progress", "completed", "overdue"]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  categoryId: z.coerce.number().optional().nullable(),
  contractorId: z.coerce.number().optional().nullable(),
  assignedTo: z.string().optional(),
  dueDate: z.string().optional().nullable(),
  leadTimeDays: z.coerce.number().optional().nullable(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function ItemFormDialog({
  isOpen,
  onClose,
  item = null,
  defaultType = "internal"
}: {
  isOpen: boolean;
  onClose: () => void;
  item?: ComplianceItem | null;
  defaultType?: ComplianceItemType;
}) {
  const { createItem, updateItem } = useAppMutations();
  const { data: categories = [] } = useListCategories();
  const { data: contractors = [] } = useListContractors();
  
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      description: "",
      type: defaultType,
      status: "pending",
      priority: "medium",
      categoryId: undefined,
      contractorId: undefined,
      assignedTo: "",
      dueDate: "",
      leadTimeDays: 7,
      notes: "",
    }
  });

  useEffect(() => {
    if (item) {
      form.reset({
        title: item.title,
        description: item.description || "",
        type: item.type,
        status: item.status,
        priority: item.priority,
        categoryId: item.categoryId || undefined,
        contractorId: item.contractorId || undefined,
        assignedTo: item.assignedTo || "",
        dueDate: item.dueDate ? new Date(item.dueDate).toISOString().slice(0, 16) : "",
        leadTimeDays: item.leadTimeDays || undefined,
        notes: item.notes || "",
      });
    } else {
      form.reset({
        title: "",
        description: "",
        type: defaultType,
        status: "pending",
        priority: "medium",
        categoryId: undefined,
        contractorId: undefined,
        assignedTo: "",
        dueDate: "",
        leadTimeDays: defaultType === "external" ? 7 : undefined,
        notes: "",
      });
    }
  }, [item, isOpen, defaultType, form]);

  const typeWatch = form.watch("type");

  const onSubmit = async (data: FormValues) => {
    try {
      const payload = {
        ...data,
        categoryId: data.categoryId || null,
        contractorId: data.type === 'external' ? (data.contractorId || null) : null,
        leadTimeDays: data.type === 'external' ? (data.leadTimeDays || null) : null,
        assignedTo: data.type === 'internal' ? data.assignedTo : null,
        dueDate: data.dueDate ? new Date(data.dueDate).toISOString() : null,
      };

      if (item) {
        await updateItem.mutateAsync({ id: item.id, data: payload });
      } else {
        await createItem.mutateAsync({ data: payload });
      }
      onClose();
    } catch (e) {
      // handled by mutation
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px] bg-card text-card-foreground">
        <DialogHeader>
          <DialogTitle className="text-xl font-display">
            {item ? "Edit Compliance Item" : "Create Compliance Item"}
          </DialogTitle>
        </DialogHeader>

        <form id="item-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="title">Title *</Label>
              <Input id="title" {...form.register("title")} className="bg-background" />
              {form.formState.errors.title && (
                <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
              )}
            </div>

            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" {...form.register("description")} className="resize-none h-20 bg-background" />
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select 
                disabled={!!item} // Don't allow changing type after creation
                value={form.watch("type")} 
                onValueChange={(val: any) => form.setValue("type", val)}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="internal">Internal Check</SelectItem>
                  <SelectItem value="external">External Contractor</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select 
                value={form.watch("categoryId")?.toString() || "none"} 
                onValueChange={(val) => form.setValue("categoryId", val === "none" ? undefined : parseInt(val))}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="Select Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select 
                value={form.watch("status")} 
                onValueChange={(val: any) => form.setValue("status", val)}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="overdue">Overdue</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select 
                value={form.watch("priority")} 
                onValueChange={(val: any) => form.setValue("priority", val)}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {typeWatch === "external" ? (
              <>
                <div className="space-y-1.5">
                  <Label>Contractor</Label>
                  <Select 
                    value={form.watch("contractorId")?.toString() || "none"} 
                    onValueChange={(val) => form.setValue("contractorId", val === "none" ? undefined : parseInt(val))}
                  >
                    <SelectTrigger className="bg-background">
                      <SelectValue placeholder="Select Contractor" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {contractors.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>{c.name} ({c.company})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Reminder Lead Time (Days)</Label>
                  <Input type="number" {...form.register("leadTimeDays")} className="bg-background" placeholder="7" />
                </div>
              </>
            ) : (
              <div className="space-y-1.5 col-span-2">
                <Label htmlFor="assignedTo">Assigned To (Internal)</Label>
                <Input id="assignedTo" {...form.register("assignedTo")} className="bg-background" />
              </div>
            )}

            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="dueDate">Due Date</Label>
              <Input type="datetime-local" id="dueDate" {...form.register("dueDate")} className="bg-background w-full" />
            </div>
            
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="notes">Internal Notes</Label>
              <Textarea id="notes" {...form.register("notes")} className="resize-none h-16 bg-background" />
            </div>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button">Cancel</Button>
          <Button type="submit" form="item-form" disabled={createItem.isPending || updateItem.isPending} className="shadow-lg shadow-primary/20">
            {createItem.isPending || updateItem.isPending ? "Saving..." : "Save Item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
