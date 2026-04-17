import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarCheck, Loader2 } from "lucide-react";

interface ScheduleInfo {
  itemTitle: string;
  notes: string | null;
  dueDate: string | null;
  contractorName: string | null;
  companyName: string;
  alreadyScheduled: string | null;
}

const apiBase = import.meta.env.VITE_API_URL ?? "";

export default function SchedulePage() {
  const [, params] = useRoute("/schedule/:token");
  const token = params?.token;

  const [info, setInfo] = useState<ScheduleInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState<{ date: string; message: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${apiBase}/api/notifications/public/schedule/${token}`)
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? "Could not load this scheduling link.");
        }
        return r.json();
      })
      .then((data: ScheduleInfo) => {
        setInfo(data);
        if (data.dueDate) {
          const d = new Date(data.dueDate);
          setDate(d.toISOString().slice(0, 10));
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !date) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/notifications/public/schedule/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: new Date(date + "T09:00:00").toISOString() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to schedule visit.");
      setConfirmed({ date, message: body.message });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-lg p-8 shadow-xl">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
          </div>
        ) : confirmed ? (
          <div className="text-center py-6">
            <div className="inline-flex items-center justify-center w-14 h-14 bg-green-100 rounded-full mb-4">
              <CalendarCheck className="w-7 h-7 text-green-600" />
            </div>
            <h1 className="text-2xl font-bold mb-2">Visit Scheduled</h1>
            <p className="text-muted-foreground mb-1">{confirmed.message}</p>
            <p className="text-sm text-muted-foreground">A calendar invite has been sent to your inbox.</p>
          </div>
        ) : error && !info ? (
          <div className="text-center py-6">
            <h1 className="text-xl font-semibold mb-2">Link unavailable</h1>
            <p className="text-muted-foreground">{error}</p>
            <p className="text-sm text-muted-foreground mt-4">If you've already proposed a date, no further action is needed. Otherwise please contact the business directly.</p>
          </div>
        ) : info ? (
          <form onSubmit={handleSubmit}>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">{info.companyName}</p>
            <h1 className="text-2xl font-bold mb-1">Schedule Your Visit</h1>
            <p className="text-muted-foreground mb-6">
              {info.contractorName ? `Hi ${info.contractorName}, ` : ""}please pick a day that works for you.
            </p>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-6">
              <p className="font-semibold text-slate-900">{info.itemTitle}</p>
              {info.notes && <p className="text-sm text-muted-foreground mt-1">{info.notes}</p>}
              {info.dueDate && (
                <p className="text-xs text-muted-foreground mt-2">
                  Due by {new Date(info.dueDate).toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
                </p>
              )}
            </div>

            {info.alreadyScheduled && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3 mb-4">
                A visit was previously scheduled for {new Date(info.alreadyScheduled).toLocaleDateString("en-GB")}. Submitting again will replace it.
              </p>
            )}

            <div className="space-y-2 mb-6">
              <Label htmlFor="visit-date">Proposed Visit Date</Label>
              <Input
                id="visit-date"
                type="date"
                value={date}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setDate(e.target.value)}
                required
              />
            </div>

            {error && <p className="text-sm text-destructive mb-4">{error}</p>}

            <Button type="submit" className="w-full" disabled={submitting || !date}>
              {submitting ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Scheduling...</>) : "Confirm Visit Date"}
            </Button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
