import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Contractor } from "@workspace/api-client-react";

// ── Trade options (must match fix-track issue types) ─────────────────────────

const TRADE_OPTIONS = [
  { value: "electrical",    label: "Electrical" },
  { value: "plumbing",      label: "Plumbing" },
  // Gas is a single issue type but we record which kind of gas work
  // the contractor covers so managers can pick the right specialist.
  { value: "gas_kitchen",   label: "Gas — Kitchen (hobs, ovens, ranges)" },
  { value: "gas_fireplace", label: "Gas — Fireplace / Fires" },
  { value: "gas_heating",   label: "Gas — Heating Plant (boilers)" },
  { value: "structural",    label: "Structural" },
  { value: "equipment",     label: "Equipment" },
  { value: "hvac",          label: "HVAC (ventilation, air handling)" },
  { value: "it_comms",      label: "IT / Comms" },
  { value: "safety_hazard", label: "Safety Hazard" },
  { value: "cleaning",      label: "Cleaning" },
  { value: "general",       label: "General" },
];

// ── Form schema ───────────────────────────────────────────────────────────────

const formSchema = z.object({
  name:    z.string().min(1, "Name is required"),
  company: z.string().optional(),
  email:   z.string().email("Valid email is required"),
  phone:   z.string().optional(),
  address: z.string().optional(),
  notes:   z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

// ── Component ─────────────────────────────────────────────────────────────────

export function ContractorFormDialog({
  isOpen,
  onClose,
  contractor = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  contractor?: (Contractor & { trades?: string[] }) | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [trades, setTrades] = useState<string[]>([]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", company: "", email: "", phone: "", address: "", notes: "" },
  });

  useEffect(() => {
    if (contractor) {
      form.reset({
        name:    contractor.name,
        company: contractor.company  || "",
        email:   contractor.email,
        phone:   contractor.phone    || "",
        address: contractor.address  || "",
        notes:   contractor.notes    || "",
      });
      setTrades(Array.isArray((contractor as any).trades) ? (contractor as any).trades : []);
    } else {
      form.reset({ name: "", company: "", email: "", phone: "", address: "", notes: "" });
      setTrades([]);
    }
  }, [contractor, isOpen, form]);

  function toggleTrade(value: string) {
    setTrades(prev =>
      prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value],
    );
  }

  const onSubmit = async (data: FormValues) => {
    setSaving(true);
    try {
      const payload = { ...data, trades };
      if (contractor) {
        const res = await apiFetch(`/contractors/${contractor.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Update failed");
      } else {
        const res = await apiFetch("/contractors", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Create failed");
      }
      // Invalidate all contractor queries so lists refresh
      await qc.invalidateQueries({ queryKey: ["contractors"] });
      await qc.invalidateQueries({ predicate: q => String(q.queryKey[0]).includes("contractor") });
      onClose();
    } catch (e: any) {
      toast({ title: "Could not save contractor", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-display">
            {contractor ? "Edit Contractor" : "Add Contractor"}
          </DialogTitle>
        </DialogHeader>

        <form id="contractor-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-2">
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

          {/* Trades / specialisms */}
          <div className="space-y-2.5">
            <div>
              <Label>Trade Specialisms</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Select the types of work this contractor covers. This enables auto-matching when maintenance issues are logged.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {TRADE_OPTIONS.map(opt => {
                const checked = trades.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleTrade(opt.value)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm text-left transition-colors ${
                      checked
                        ? "bg-primary/10 border-primary/40 text-primary font-medium"
                        : "bg-muted/40 border-border text-muted-foreground hover:border-primary/30"
                    }`}
                  >
                    <span className={`w-3.5 h-3.5 rounded-sm border flex-shrink-0 flex items-center justify-center ${
                      checked ? "bg-primary border-primary" : "border-muted-foreground/40"
                    }`}>
                      {checked && (
                        <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12">
                          <path d="M10 3L5 8.5 2 5.5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </span>
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {trades.length > 0 && (
              <p className="text-xs text-primary font-medium">
                {trades.length} trade{trades.length !== 1 ? "s" : ""} selected
              </p>
            )}
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button">Cancel</Button>
          <Button type="submit" form="contractor-form" disabled={saving}>
            {saving ? "Saving…" : "Save Contractor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
