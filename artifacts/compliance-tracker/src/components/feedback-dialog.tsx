import { useEffect, useState } from "react";
import { MessageSquareWarning } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [category, setCategory] = useState("feedback");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setCategory("feedback");
      setSummary("");
      setDetails("");
    }
  }, [open]);

  async function submit() {
    if (summary.trim().length < 3 || details.trim().length < 10) {
      toast({ title: "Add a little more detail", description: "Include a short summary and at least 10 characters of detail.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const response = await apiFetch("/feedback", {
        method: "POST",
        body: JSON.stringify({ category, summary, details, pagePath: window.location.pathname }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Feedback could not be submitted");
      toast({
        title: "Thank you — your report was saved",
        description: body.emailSent ? "The ComplyTrack support team has also been notified." : "Support can review it even though the email notification was delayed.",
      });
      onOpenChange(false);
    } catch (err) {
      toast({ title: "Could not submit feedback", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg rounded-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareWarning className="h-5 w-5 text-primary" />
            Submit feedback
          </DialogTitle>
          <DialogDescription>Share feedback, flag a problem, or suggest an improvement.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="feedback-category">Type</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="feedback-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="feedback">General feedback</SelectItem>
                <SelectItem value="bug">Flag an issue</SelectItem>
                <SelectItem value="feature">Suggest an improvement</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="feedback-summary">Summary</Label>
            <Input id="feedback-summary" value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={160} placeholder="What would you like us to know?" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="feedback-details">Details</Label>
            <Textarea id="feedback-details" value={details} onChange={(event) => setDetails(event.target.value)} maxLength={5000} rows={6} placeholder="Tell us what happened, what you expected, or what would make ComplyTrack better." />
            <p className="text-xs text-muted-foreground">The current page and your account details are included automatically.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? "Submitting…" : "Submit feedback"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}