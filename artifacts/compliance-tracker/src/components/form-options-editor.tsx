import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Settings, Plus, X, RotateCcw } from "lucide-react";
import {
  useFormOptions, useFormOptionsApi, type FormOptionKey,
} from "@/hooks/use-form-options";

interface FormOptionsEditorProps {
  optionKey: FormOptionKey;
  /** Heading shown in the dialog, e.g. "Incident types". */
  title: string;
  /** Optional friendly label for a stored value (defaults to the raw value). */
  labelFor?: (value: string) => string;
  /** Optional trigger button label (defaults to "Customise options"). */
  triggerLabel?: string;
}

/**
 * Admin-only editor for a single per-client option list. Mirrors the PATtrack
 * preset editor UX: add rows, remove rows, save, or reset to the built-in
 * default. Only renders for client admins / consultants.
 */
export function FormOptionsEditor({ optionKey, title, labelFor, triggerLabel }: FormOptionsEditorProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === "client_admin" || user?.role === "consultant";
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const [newItem, setNewItem] = useState("");
  const [saving, setSaving] = useState(false);
  const { data } = useFormOptions();
  const call = useFormOptionsApi();
  const qc = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!open || !data) return;
    setItems([...(data.options?.[optionKey] ?? [])]);
    setNewItem("");
  }, [open, data, optionKey]);

  if (!isAdmin) return null;

  const label = (v: string) => (labelFor ? labelFor(v) : v);

  const addItem = () => {
    const trimmed = newItem.trim();
    if (!trimmed) return;
    if (items.some(i => i.toLowerCase() === trimmed.toLowerCase())) {
      toast({ title: "Already in the list", variant: "destructive" });
      return;
    }
    if (trimmed.length > 60) {
      toast({ title: "Too long", description: "Max 60 characters", variant: "destructive" });
      return;
    }
    if (items.length >= 50) {
      toast({ title: "Too many items", description: "Max 50 options", variant: "destructive" });
      return;
    }
    setItems([...items, trimmed]);
    setNewItem("");
  };

  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const invalidate = () => qc.invalidateQueries({ queryKey: ["form-options"] });

  const handleSave = async () => {
    if (items.length === 0) {
      toast({ title: "List cannot be empty", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await call(`/${optionKey}`, { method: "PUT", body: JSON.stringify({ items }) });
      invalidate();
      toast({ title: "Options saved" });
      setOpen(false);
    } catch (e: any) {
      toast({ title: "Failed to save", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      const res = await call<{ items: string[] }>(`/${optionKey}`, { method: "DELETE" });
      invalidate();
      setItems([...(res?.items ?? data?.defaults?.[optionKey] ?? [])]);
      toast({ title: "Reset to default" });
    } catch (e: any) {
      toast({ title: "Failed to reset", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 rounded-sm h-8">
          <Settings className="w-3.5 h-3.5" /> {triggerLabel ?? "Customise options"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <p className="text-xs text-muted-foreground">
            Customise the options shown in this dropdown. Existing records keep
            their current values even if you remove an option.
          </p>

          <div className="space-y-1.5 max-h-[45vh] overflow-y-auto pr-1">
            {items.map((item, idx) => (
              <div key={`${item}-${idx}`} className="flex items-center gap-2 rounded-sm border px-2.5 py-1.5">
                <span className="flex-1 text-sm truncate" title={item}>{label(item)}</span>
                <Button
                  type="button" variant="ghost" size="icon"
                  className="h-6 w-6 shrink-0" onClick={() => removeItem(idx)}
                  aria-label={`Remove ${label(item)}`}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
            {items.length === 0 && (
              <p className="text-sm text-muted-foreground italic px-1">No options yet — add one below.</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Input
              className="rounded-sm h-9"
              placeholder="Add an option…"
              value={newItem}
              onChange={e => setNewItem(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
              maxLength={60}
            />
            <Button type="button" variant="secondary" size="sm" className="rounded-sm h-9 gap-1" onClick={addItem}>
              <Plus className="w-3.5 h-3.5" /> Add
            </Button>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" size="sm" className="gap-1.5 rounded-sm" onClick={handleReset} disabled={saving}>
            <RotateCcw className="w-3.5 h-3.5" /> Reset to default
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="rounded-sm" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" size="sm" className="rounded-sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
