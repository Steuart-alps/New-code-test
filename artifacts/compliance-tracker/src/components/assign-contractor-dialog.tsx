import { useEffect, useState } from "react";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Loader2, Send } from "lucide-react";

export interface AssignContractorIssue {
  id: number;
  title: string;
  issueType: string;
  contractorId?: number | null;
  contractorName?: string | null;
  targetDate?: string | null;
  emailRequestMode?: string | null;
  emailRequestStatus?: string | null;
}

interface ContractorOption {
  id: number;
  name: string;
  company?: string | null;
  email?: string | null;
  trades?: string[] | null;
}

// Gas is one issue type but three trades, as on the issue form.
const GAS_SUBTRADES = ["gas_kitchen", "gas_fireplace", "gas_heating", "gas"];
const NEW_CONTRACTOR = "__new__";

/**
 * A manager gives a FixTrack job to a contractor, picked from the business's
 * Contractors list or added here, and the job is emailed to them at once.
 */
export function AssignContractorDialog({ issue, open, onOpenChange, onAssigned }: {
  issue: AssignContractorIssue | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssigned: () => void | Promise<void>;
}) {
  const { activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();
  const { toast } = useToast();
  const [contractors, setContractors] = useState<ContractorOption[]>([]);
  const [choice, setChoice] = useState("");
  const [newContractor, setNewContractor] = useState({ name: "", company: "", email: "", phone: "" });
  const [targetDate, setTargetDate] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    clientApiFetch("/contractors")
      .then(r => r.ok ? r.json() : [])
      .then(setContractors)
      .catch(() => setContractors([]));
  }, [open, activeClientId, clientApiFetch]);

  useEffect(() => {
    if (!open || !issue) return;
    setChoice(issue.contractorId ? String(issue.contractorId) : "");
    setNewContractor({ name: "", company: "", email: "", phone: "" });
    setTargetDate(issue.targetDate?.slice(0, 10) ?? "");
  }, [open, issue]);

  if (!issue) return null;

  const matchTrades = issue.issueType === "gas" ? GAS_SUBTRADES : [issue.issueType];
  const matching = contractors.filter(c => Array.isArray(c.trades) && c.trades.some(t => matchTrades.includes(t)));
  const others = contractors.filter(c => !matching.includes(c));
  const chosen = contractors.find(c => String(c.id) === choice);
  const alreadySent = issue.emailRequestStatus === "sent" && issue.emailRequestMode !== "quote";
  const addingNew = choice === NEW_CONTRACTOR;
  const ready = addingNew
    ? newContractor.name.trim() !== "" && /\S+@\S+\.\S+/.test(newContractor.email.trim())
    : !!chosen?.email;

  async function submit() {
    if (!issue || !ready) return;
    setSaving(true);
    try {
      const res = await clientApiFetch(`/fix-track/issues/${issue.id}/assign-contractor`, {
        method: "POST",
        body: JSON.stringify({
          ...(addingNew
            ? { newContractor: {
                name: newContractor.name.trim(),
                email: newContractor.email.trim(),
                company: newContractor.company.trim() || null,
                phone: newContractor.phone.trim() || null,
              } }
            : { contractorId: Number(choice) }),
          targetDate: targetDate || null,
          ...(issue.emailRequestStatus === "sent" ? { replace: true } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The contractor is saved on the issue even when the email fails; it
        // waits in Contractor Approvals to retry.
        if (res.status >= 500) await onAssigned();
        throw new Error(body?.error ?? "The job could not be sent");
      }
      toast({ title: body?.message ?? "Job emailed to the contractor", description: "They can pick a visit date and tell you when it's done from the email." });
      onOpenChange(false);
      await onAssigned();
    } catch (err: any) {
      toast({ title: "Could not send the job", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign a contractor</DialogTitle>
          <DialogDescription>
            The contractor gets "{issue.title}" by email with the details and photos, a link to pick their visit date, and a link to say when it's done.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="assign-contractor-choice">Contractor</Label>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger id="assign-contractor-choice" data-testid="select-assign-contractor">
                <SelectValue placeholder="Choose a contractor" />
              </SelectTrigger>
              <SelectContent>
                {matching.length > 0 && others.length > 0 && (
                  <div className="px-2 py-1 text-xs text-muted-foreground font-medium">Do this type of work</div>
                )}
                {matching.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}{c.company ? ` (${c.company})` : ""}</SelectItem>
                ))}
                {matching.length > 0 && others.length > 0 && (
                  <div className="px-2 py-1 text-xs text-muted-foreground font-medium border-t mt-1 pt-1">Other contractors</div>
                )}
                {others.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}{c.company ? ` (${c.company})` : ""}</SelectItem>
                ))}
                <SelectItem value={NEW_CONTRACTOR}>+ Add a new contractor</SelectItem>
              </SelectContent>
            </Select>
            {chosen && !chosen.email && (
              <p className="text-xs text-amber-700 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> This contractor has no email address. Add one on the Contractors page.
              </p>
            )}
          </div>

          {addingNew && (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">They are added to your Contractors list too.</p>
              <div className="space-y-1.5">
                <Label htmlFor="new-contractor-name">Name *</Label>
                <Input id="new-contractor-name" value={newContractor.name} maxLength={200}
                  onChange={e => setNewContractor({ ...newContractor, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-contractor-company">Company</Label>
                <Input id="new-contractor-company" value={newContractor.company} maxLength={200}
                  onChange={e => setNewContractor({ ...newContractor, company: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="new-contractor-email">Email *</Label>
                  <Input id="new-contractor-email" type="email" value={newContractor.email} maxLength={320}
                    onChange={e => setNewContractor({ ...newContractor, email: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="new-contractor-phone">Phone</Label>
                  <Input id="new-contractor-phone" type="tel" value={newContractor.phone} maxLength={50}
                    onChange={e => setNewContractor({ ...newContractor, phone: e.target.value })} />
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="assign-contractor-target">Needed by (optional)</Label>
            <Input id="assign-contractor-target" type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
            <p className="text-xs text-muted-foreground">Sent as a calendar invite. The contractor picks the actual visit date.</p>
          </div>

          {alreadySent && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">
              This job was already emailed to {issue.contractorName ?? "a contractor"}. Sending it now gives the job to the contractor you choose, and the links in the earlier email stop working.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={!ready || saving} className="gap-1.5" data-testid="button-assign-contractor-send">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Assign and email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
