import { useEffect } from "react";
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
import { useAppMutations } from "@/hooks/use-app-data";
import { Contractor } from "@workspace/api-client-react";

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  company: z.string().optional(),
  email: z.string().email("Valid email is required"),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function ContractorFormDialog({
  isOpen,
  onClose,
  contractor = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  contractor?: Contractor | null;
}) {
  const { createContractor, updateContractor } = useAppMutations();
  
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      company: "",
      email: "",
      phone: "",
      address: "",
      notes: "",
    }
  });

  useEffect(() => {
    if (contractor) {
      form.reset({
        name: contractor.name,
        company: contractor.company || "",
        email: contractor.email,
        phone: contractor.phone || "",
        address: contractor.address || "",
        notes: contractor.notes || "",
      });
    } else {
      form.reset({
        name: "",
        company: "",
        email: "",
        phone: "",
        address: "",
        notes: "",
      });
    }
  }, [contractor, isOpen, form]);

  const onSubmit = async (data: FormValues) => {
    try {
      if (contractor) {
        await updateContractor.mutateAsync({ id: contractor.id, data });
      } else {
        await createContractor.mutateAsync({ data });
      }
      onClose();
    } catch (e) {
      // handled by mutation
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-xl font-display">
            {contractor ? "Edit Contractor" : "Add Contractor"}
          </DialogTitle>
        </DialogHeader>

        <form id="contractor-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label htmlFor="name">Contact Name *</Label>
              <Input id="name" {...form.register("name")} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label htmlFor="company">Company</Label>
              <Input id="company" {...form.register("company")} />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label htmlFor="email">Email *</Label>
              <Input type="email" id="email" {...form.register("email")} />
              {form.formState.errors.email && (
                <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" {...form.register("phone")} />
            </div>

            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="address">Address</Label>
              <Input id="address" {...form.register("address")} />
            </div>
            
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" {...form.register("notes")} className="resize-none h-20" />
            </div>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button">Cancel</Button>
          <Button type="submit" form="contractor-form" disabled={createContractor.isPending || updateContractor.isPending}>
            {createContractor.isPending || updateContractor.isPending ? "Saving..." : "Save Contractor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
