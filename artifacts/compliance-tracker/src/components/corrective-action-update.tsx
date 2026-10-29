import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface CorrectiveActionState {
  id: number;
  status: string;
  evidenceReference?: string | null;
}

/** Reads the API's error, which is a string or zod's flattened field errors. */
async function errorMessage(response: Response): Promise<string> {
  const error = (await response.json().catch(() => null))?.error;
  if (typeof error === "string") return error;
  const [field, messages] = Object.entries<string[]>(error?.fieldErrors ?? {})[0] ?? [];
  return field ? `${field}: ${messages?.[0] ?? "invalid"}` : "Request failed";
}

/**
 * Moves a corrective action on (open, in progress, awaiting verification) or
 * verifies it closed, on the track the action came from.
 */
export function CorrectiveActionUpdate({ action, onSaved, onCancel }: {
  action: CorrectiveActionState;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [update, setUpdate] = useState({ status: action.status, evidenceReference: action.evidenceReference ?? "", verificationNotes: "" });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const response = await apiFetch(`/compliance-hub/actions/${action.id}`, { method: "PATCH", body: JSON.stringify(update) });
      if (!response.ok) throw new Error(await errorMessage(response));
      toast({ title: update.status === "verified" ? "Action verified closed" : "Corrective action updated" });
      await onSaved();
    } catch (error) {
      toast({ title: "Couldn't update action", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-3 border-t pt-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`action-status-${action.id}`}>Action status</Label>
        <Select value={update.status} onValueChange={(status) => setUpdate({ ...update, status })}>
          <SelectTrigger id={`action-status-${action.id}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_progress">In progress</SelectItem>
            <SelectItem value="awaiting_verification">Awaiting verification</SelectItem>
            <SelectItem value="verified">Verified closed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`action-evidence-${action.id}`}>Evidence reference</Label>
        <Input id={`action-evidence-${action.id}`} value={update.evidenceReference} onChange={(e) => setUpdate({ ...update, evidenceReference: e.target.value })} placeholder="Document title, certificate, photo record or storage link" />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`action-notes-${action.id}`}>Verification notes {update.status === "verified" ? "(required)" : ""}</Label>
        <Textarea id={`action-notes-${action.id}`} value={update.verificationNotes} onChange={(e) => setUpdate({ ...update, verificationNotes: e.target.value })} placeholder="Who verified the action, what they checked and when" />
        <p className="text-xs text-muted-foreground">Verified closure is available only from “Awaiting verification”, by a different Owner or consultant. It cannot be edited afterwards.</p>
      </div>
      <div className="flex gap-2 md:col-span-2">
        <Button size="sm" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save action update"}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
