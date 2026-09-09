import React, { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, CheckCircle2, XCircle, Building, MapPin, Briefcase } from "lucide-react";

export default function ContractorQuotePage() {
  const [match, params] = useRoute("/contractor-quote/:token");
  const token = params?.token;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { toast } = useToast();

  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    apiFetch(`/fix-track/quotes/public/${token}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load quote details. The link may have expired.");
        setData(await res.json());
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    
    // Parse price as number
    const numPrice = parseFloat(price);
    if (isNaN(numPrice) || numPrice < 0) {
      toast({ title: "Invalid price", description: "Please enter a valid amount in pounds.", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch(`/fix-track/quotes/public/${token}`, {
        method: "POST",
        body: JSON.stringify({
          poundsPrice: numPrice,
          notes
        })
      });
      if (!res.ok) throw new Error(await res.text());
      setSubmitted(true);
    } catch (err: any) {
      toast({ title: "Error submitting quote", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/20">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/20 p-4">
        <div className="max-w-md w-full bg-card border rounded-xl p-6 text-center shadow-sm">
          <div className="w-12 h-12 rounded-full bg-rose-100 flex items-center justify-center text-rose-600 mx-auto mb-4">
            <XCircle className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold mb-2">Quote Link Invalid</h1>
          <p className="text-muted-foreground text-sm">{error || "This link is no longer valid."}</p>
        </div>
      </div>
    );
  }

  if (submitted || data.submitted || data.quote?.status === "submitted") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/20 p-4">
        <div className="max-w-md w-full bg-card border rounded-xl p-6 text-center shadow-sm">
          <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 mx-auto mb-4">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold mb-2">Quote Submitted</h1>
          <p className="text-muted-foreground text-sm">
            Thank you. Your quote has been submitted to the manager for review. We will be in touch if it is approved.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/20 py-12 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-display font-bold text-foreground">Submit Quote</h1>
          <p className="text-muted-foreground text-sm mt-1">Please provide your estimate for the requested job.</p>
        </div>

        <div className="bg-card border rounded-xl overflow-hidden shadow-sm">
          <div className="p-5 border-b bg-muted/10">
            <h2 className="font-semibold text-lg flex items-center gap-2 mb-3">
              <Briefcase className="w-5 h-5 text-muted-foreground" />
              {data.jobTitle || data.job?.title || "Job Request"}
            </h2>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <span className="text-muted-foreground">
                  <strong className="text-foreground block">Site Location</strong>
                  {data.siteName || data.job?.siteName || "Unknown Site"}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <Building className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <span className="text-muted-foreground">
                  <strong className="text-foreground block">Client</strong>
                  {data.clientName || "ComplyTrack Customer"}
                </span>
              </div>
            </div>
            {(data.description || data.job?.description) && (
              <div className="mt-4 pt-4 border-t text-sm">
                <strong className="block mb-1">Job Description:</strong>
                <p className="whitespace-pre-wrap text-muted-foreground">{data.description || data.job?.description}</p>
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-5">
            <div>
              <label className="block text-sm font-medium mb-1.5">Estimated Price (£) *</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-muted-foreground">£</span>
                <Input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  className="pl-8"
                  value={price}
                  onChange={e => setPrice(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">Additional Notes (Optional)</label>
              <Textarea
                placeholder="Include any conditions, timeline estimates, or details about the quote..."
                className="min-h-[120px]"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            <Button type="submit" className="w-full h-11" disabled={submitting}>
              {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Submit Quote
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
