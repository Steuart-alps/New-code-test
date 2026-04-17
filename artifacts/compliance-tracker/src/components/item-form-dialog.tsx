import { useState, useEffect, useMemo } from "react";
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel
} from "@/components/ui/select";
import { useAppMutations } from "@/hooks/use-app-data";
import { ComplianceItem, useListCategories, useListSites, useListContractors } from "@workspace/api-client-react";

const formSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "overdue"]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  siteId: z.coerce.number().optional().nullable(),
  contractorId: z.coerce.number().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  leadTimeDays: z.coerce.number().optional().nullable(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function ItemFormDialog({
  isOpen,
  onClose,
  item = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  item?: ComplianceItem | null;
}) {
  const { createItem, updateItem } = useAppMutations();
  const { data: categories = [] } = useListCategories();
  const { data: sites = [] } = useListSites();
  const { data: contractors = [] } = useListContractors();

  // Group sites by category for the dropdown
  const grouped = useMemo(() => {
    const byCat = new Map<number | null, typeof sites>();
    for (const s of sites) {
      const k = s.categoryId ?? null;
      if (!byCat.has(k)) byCat.set(k, [] as any);
      byCat.get(k)!.push(s);
    }
    return categories.map(c => ({ category: c, sites: byCat.get(c.id) ?? [] }))
      .concat(byCat.has(null) ? [{ category: { id: -1, name: "Uncategorised", color: "#94a3b8", createdAt: "" } as any, sites: byCat.get(null)! }] : []);
  }, [categories, sites]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "", description: "", status: "pending", priority: "medium",
      siteId: undefined, contractorId: undefined, dueDate: "", leadTimeDays: 7, notes: "",
    }
  });

  useEffect(() => {
    if (item) {
      form.reset({
        title: item.title,
        description: item.description || "",
        status: item.status,
        priority: item.priority,
        siteId: item.siteId || undefined,
        contractorId: item.contractorId || undefined,
        dueDate: item.dueDate ? new Date(item.dueDate).toISOString().slice(0, 16) : "",
        leadTimeDays: item.leadTimeDays || 7,
        notes: item.notes || "",
      });
    } else {
      form.reset({
        title: "", description: "", status: "pending", priority: "medium",
        siteId: undefined, contractorId: undefined, dueDate: "", leadTimeDays: 7, notes: "",
      });
    }
  }, [item, isOpen, form]);

  const onSubmit = async (data: FormValues) => {
    try {
      const payload = {
        ...data,
        siteId: data.siteId || null,
        contractorId: data.contractorId || null,
        leadTimeDays: data.leadTimeDays || null,
        assignedTo: null,
        dueDate: data.dueDate ? new Date(data.dueDate).toISOString() : null,
      };

      if (item) await updateItem.mutateAsync({ id: item.id, data: payload });
      else await createItem.mutateAsync({ data: payload });
      onClose();
    } catch (e) {
      // handled by mutation
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[580px] bg-card text-card-foreground p-0 gap-0">
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border">
          <DialogTitle className="text-lg font-display">
            {item ? "Edit Compliance Check" : "Add Compliance Check"}
          </DialogTitle>
        </DialogHeader>

        <form id="item-form" onSubmit={form.handleSubmit(onSubmit)} className="px-6 pt-4 pb-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div className="col-span-2 space-y-1">
              <Label htmlFor="title" className="text-xs font-medium">Title *</Label>
              <Input id="title" {...form.register("title")} className="bg-background h-9" />
              {form.formState.errors.title && (
                <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Site</Label>
              <Select
                value={form.watch("siteId")?.toString() || "none"}
                onValueChange={(val) => form.setValue("siteId", val === "none" ? undefined : parseInt(val))}
              >
                <SelectTrigger className="bg-background h-9">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {grouped.map(({ category, sites: catSites }) => (
                    catSites.length > 0 && (
                      <SelectGroup key={category.id}>
                        <SelectLabel className="text-xs uppercase tracking-wider opacity-60">{category.name}</SelectLabel>
                        {catSites.map(s => (
                          <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    )
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Status</Label>
              <Select
                value={form.watch("status")}
                onValueChange={(val: any) => form.setValue("status", val)}
              >
                <SelectTrigger className="bg-background h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="overdue">Overdue</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Priority</Label>
              <Select
                value={form.watch("priority")}
                onValueChange={(val: any) => form.setValue("priority", val)}
              >
                <SelectTrigger className="bg-background h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Contractor</Label>
              <Select
                value={form.watch("contractorId")?.toString() || "none"}
                onValueChange={(val) => form.setValue("contractorId", val === "none" ? undefined : parseInt(val))}
              >
                <SelectTrigger className="bg-background h-9"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {contractors.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()}>{c.name}{c.company ? ` — ${c.company}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Due Date</Label>
              <Input type="datetime-local" id="dueDate" {...form.register("dueDate")} className="bg-background h-9 w-full" />
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Alert Lead Time (Days)</Label>
              <Input type="number" {...form.register("leadTimeDays")} className="bg-background h-9" placeholder="7" />
            </div>

            <div className="col-span-2 space-y-1">
              <Label htmlFor="notes" className="text-xs font-medium">Notes</Label>
              <Textarea id="notes" {...form.register("notes")} className="resize-none h-14 bg-background" />
            </div>
          </div>
        </form>

        <DialogFooter className="px-6 py-4 border-t border-border bg-white mt-2">
          <Button variant="outline" onClick={onClose} type="button">Cancel</Button>
          <Button type="submit" form="item-form" disabled={createItem.isPending || updateItem.isPending} className="bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600">
            {createItem.isPending || updateItem.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
