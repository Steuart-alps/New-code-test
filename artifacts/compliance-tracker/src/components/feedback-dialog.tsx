import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { ImagePlus, Loader2, MessageSquareWarning, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];
const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
// The commit the web build came from (set on Render), shortened for reading.
const APP_VERSION = ((import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ?? "").slice(0, 12) || null;

type Screenshot = { objectPath: string; fileName: string; previewUrl: string };

export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [category, setCategory] = useState("feedback");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setCategory("feedback");
      setSummary("");
      setDetails("");
      setScreenshot(null);
    }
  }, [open]);

  useEffect(() => () => { if (screenshot) URL.revokeObjectURL(screenshot.previewUrl); }, [screenshot]);

  // Uploads straight to storage; the API checks the image when the report is sent.
  async function attach(file: File) {
    if (!SCREENSHOT_TYPES.includes(file.type)) {
      toast({ title: "Choose a PNG, JPEG or WebP image", variant: "destructive" });
      return;
    }
    if (file.size > SCREENSHOT_MAX_BYTES) {
      toast({ title: "That image is too large", description: "Screenshots can be up to 10 MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const signed = await apiFetch("/feedback/screenshot/request-upload", {
        method: "POST",
        body: JSON.stringify({ contentType: file.type }),
      });
      const body = await signed.json().catch(() => ({}));
      if (!signed.ok) throw new Error(body.error ?? "Could not start the upload");
      const put = await fetch(body.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) throw new Error("The upload did not finish. Please try again.");
      setScreenshot({ objectPath: body.objectPath, fileName: file.name || "screenshot.png", previewUrl: URL.createObjectURL(file) });
    } catch (err) {
      toast({
        title: "Could not attach the screenshot",
        description: `${err instanceof Error ? err.message : "Please try again."} You can still send your feedback without it.`,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // A screenshot copied to the clipboard can be pasted straight into the form.
  function onPaste(event: ClipboardEvent) {
    const item = Array.from(event.clipboardData.items).find(i => i.kind === "file" && SCREENSHOT_TYPES.includes(i.type));
    const file = item?.getAsFile();
    if (!file || uploading || submitting) return;
    event.preventDefault();
    attach(file);
  }

  async function submit() {
    if (summary.trim().length < 3 || details.trim().length < 10) {
      toast({ title: "Add a little more detail", description: "Include a short summary and at least 10 characters of detail.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const response = await apiFetch("/feedback", {
        method: "POST",
        body: JSON.stringify({
          category, summary, details, pagePath: window.location.pathname, appVersion: APP_VERSION,
          screenshot: screenshot ? { objectPath: screenshot.objectPath, fileName: screenshot.fileName } : null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Feedback could not be submitted");
      toast({
        title: "Thank you, your report was sent",
        description: body.emailSent ? "The ALPS team has been emailed and will look at it." : "It has been saved for the ALPS team. If it is urgent, you can also email info@alpsconsultancy.co.uk.",
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
      <DialogContent className="max-w-lg rounded-sm" onPaste={onPaste}>
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
            <Input id="feedback-summary" dictation value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={160} placeholder="What would you like us to know?" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="feedback-details">Details</Label>
            <Textarea id="feedback-details" value={details} onChange={(event) => setDetails(event.target.value)} maxLength={5000} rows={6} placeholder="Tell us what happened, what you expected, or what would make ComplyTrack better." />
            <p className="text-xs text-muted-foreground">The current page, the app version and your account details are included automatically.</p>
          </div>
          <div className="space-y-2">
            <Label>Screenshot (optional)</Label>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              data-testid="input-feedback-screenshot"
              onChange={(event) => event.target.files?.[0] && attach(event.target.files[0])}
            />
            {screenshot ? (
              <div className="flex items-center gap-3 border p-2" data-testid="feedback-screenshot-attached">
                <img src={screenshot.previewUrl} alt="Attached screenshot" className="h-14 w-20 object-cover border" />
                <span className="flex-1 truncate text-xs">{screenshot.fileName}</span>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove screenshot" disabled={submitting} onClick={() => setScreenshot(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" className="w-full justify-start gap-2" disabled={uploading || submitting}
                onClick={() => fileRef.current?.click()} data-testid="button-feedback-screenshot">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                {uploading ? "Attaching…" : "Attach a screenshot"}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">PNG, JPEG or WebP, up to 10 MB. You can also paste a copied screenshot here. Only the ALPS team and your business's administrators can see it.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || uploading}>{submitting ? "Submitting…" : "Submit feedback"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}