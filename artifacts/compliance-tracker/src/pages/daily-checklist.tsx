import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Sun, Moon, ArrowLeft } from "lucide-react";
import { Link } from "wouter";

interface Site {
  id: number;
  name: string;
  clientId: number;
}

interface Answer {
  question: string;
  checked: boolean;
  notes?: string;
}

interface Submission {
  id: number;
  submittedAt: string;
  submittedByName: string | null;
  signedOffAt: string | null;
  signedOffByName: string | null;
  answers: Answer[];
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

export default function DailyChecklistPage({ type }: { type: "am" | "pm" }) {
  const { user, activeClientId } = useAuth();
  const isManager = user?.role === "consultant" || user?.role === "client_admin";

  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string>("");
  const [date] = useState(todayDate());
  const [loading, setLoading] = useState(true);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [signingOff, setSigningOff] = useState(false);
  const [signOffDone, setSignOffDone] = useState(false);
  const [error, setError] = useState("");

  // Load sites
  useEffect(() => {
    async function loadSites() {
      const res = await apiFetch(`/sites${activeClientId ? `?clientId=${activeClientId}` : ""}`);
      if (res.ok) {
        const data: Site[] = await res.json();
        setSites(data);
        if (data.length === 1) setSiteId(String(data[0].id));
      }
    }
    loadSites();
  }, [activeClientId]);

  // Load existing submission when site is chosen
  useEffect(() => {
    if (!siteId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setSubmission(null);
    setSubmitted(false);
    setSignOffDone(false);

    async function loadSubmission() {
      try {
        const res = await apiFetch(`/daily-checklists/${siteId}/${date}/${type}`);
        if (res.ok) {
          const data = await res.json();
          if (data.submission) {
            setSubmission(data.submission);
            setAnswers(data.submission.answers);
            setSubmitted(true);
            setSignOffDone(!!data.submission.signedOffAt);
          } else {
            // Use default questions
            setAnswers(data.defaultQuestions);
          }
        }
      } finally {
        setLoading(false);
      }
    }
    loadSubmission();
  }, [siteId, date, type]);

  function toggleChecked(idx: number) {
    setAnswers(prev => prev.map((a, i) => i === idx ? { ...a, checked: !a.checked } : a));
  }

  function setNotes(idx: number, notes: string) {
    setAnswers(prev => prev.map((a, i) => i === idx ? { ...a, notes } : a));
  }

  async function handleSubmit() {
    if (!siteId) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await apiFetch(`/daily-checklists/${siteId}/${date}/${type}`, {
        method: "POST",
        body: JSON.stringify({ answers }),
      });
      if (res.ok) {
        const data = await res.json();
        setSubmission(data);
        setSubmitted(true);
      } else {
        const d = await res.json();
        setError(d.error ?? "Failed to submit");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOff() {
    if (!siteId) return;
    setSigningOff(true);
    setError("");
    try {
      const res = await apiFetch(`/daily-checklists/${siteId}/${date}/pm/sign-off`, {
        method: "POST",
        body: JSON.stringify({ notes: "" }),
      });
      if (res.ok) {
        setSignOffDone(true);
      } else {
        const d = await res.json();
        setError(d.error ?? "Failed to sign off");
      }
    } finally {
      setSigningOff(false);
    }
  }

  const isAm = type === "am";
  const Icon = isAm ? Sun : Moon;
  const label = isAm ? "AM · Opening Checklist" : "PM · Closing Checklist";
  const colorClass = isAm ? "text-sky-600" : "text-indigo-600";
  const bgClass = isAm ? "bg-sky-50 border-sky-200" : "bg-indigo-50 border-indigo-200";

  const checkedCount = answers.filter(a => a.checked).length;
  const allChecked = answers.length > 0 && checkedCount === answers.length;

  return (
    <AppLayout title={label}>
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/daily/overview">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-medium ${bgClass} ${colorClass}`}>
            <Icon className="w-4 h-4" />
            {label}
          </div>
          <div className="text-sm text-muted-foreground ml-auto">
            {new Date(date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
          </div>
        </div>

        {/* Site selector */}
        {sites.length > 1 && (
          <div className="bg-card border border-border rounded-lg p-4 space-y-2">
            <label className="text-sm font-medium">Select site</label>
            <Select value={siteId} onValueChange={setSiteId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a site…" />
              </SelectTrigger>
              <SelectContent>
                {sites.map(s => (
                  <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!siteId ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            {sites.length === 0 ? "No sites found. Add a site first." : "Select a site to begin."}
          </div>
        ) : loading ? (
          <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
        ) : submitted ? (
          /* ── Already submitted ── */
          <div className="space-y-4">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-5 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium text-emerald-800">
                  {isAm ? "Opening" : "Closing"} checklist submitted
                </p>
                <p className="text-sm text-emerald-700 mt-0.5">
                  {checkedCount} of {answers.length} items checked
                  {submission?.submittedByName ? ` · by ${submission.submittedByName}` : ""}
                </p>
                {type === "pm" && (
                  <p className="text-sm text-emerald-700 mt-1">
                    {signOffDone
                      ? `✓ Signed off${submission?.signedOffByName ? ` by ${submission.signedOffByName}` : ""}`
                      : "Awaiting manager sign-off"}
                  </p>
                )}
              </div>
            </div>

            {/* Read-only answers */}
            <div className="bg-card border border-border rounded-lg divide-y divide-border">
              {answers.map((answer, idx) => (
                <div key={idx} className="px-5 py-3 flex items-start gap-3">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${answer.checked ? "bg-emerald-100" : "bg-muted"}`}>
                    {answer.checked && <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm ${answer.checked ? "text-foreground" : "text-muted-foreground"}`}>{answer.question}</p>
                    {answer.notes && <p className="text-xs text-muted-foreground mt-0.5 italic">{answer.notes}</p>}
                  </div>
                </div>
              ))}
            </div>

            {/* Sign-off button (PM, managers only) */}
            {type === "pm" && isManager && !signOffDone && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-amber-800">Manager sign-off required</p>
                  <p className="text-xs text-amber-700 mt-0.5">Confirm you have reviewed the closing checklist.</p>
                </div>
                <Button
                  onClick={handleSignOff}
                  disabled={signingOff}
                  className="bg-amber-600 hover:bg-amber-700 text-white shrink-0"
                  size="sm"
                >
                  {signingOff ? "Signing…" : "Sign off"}
                </Button>
              </div>
            )}
          </div>
        ) : (
          /* ── Checklist form ── */
          <div className="space-y-4">
            {/* Progress bar */}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{checkedCount} of {answers.length} items checked</span>
              {allChecked && <Badge variant="secondary" className="text-emerald-700 bg-emerald-100">All clear</Badge>}
            </div>
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${allChecked ? "bg-emerald-500" : isAm ? "bg-sky-500" : "bg-indigo-500"}`}
                style={{ width: answers.length > 0 ? `${(checkedCount / answers.length) * 100}%` : "0%" }}
              />
            </div>

            <div className="bg-card border border-border rounded-lg divide-y divide-border">
              {answers.map((answer, idx) => (
                <div key={idx} className="px-5 py-4 space-y-2">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id={`q-${idx}`}
                      checked={answer.checked}
                      onCheckedChange={() => toggleChecked(idx)}
                      className="mt-0.5"
                    />
                    <label
                      htmlFor={`q-${idx}`}
                      className={`text-sm cursor-pointer flex-1 leading-relaxed ${answer.checked ? "line-through text-muted-foreground" : "text-foreground"}`}
                    >
                      {answer.question}
                    </label>
                  </div>
                  {answer.checked && (
                    <div className="pl-7">
                      <Textarea
                        placeholder="Add a note (optional)…"
                        className="text-xs min-h-[52px] resize-none"
                        value={answer.notes ?? ""}
                        onChange={e => setNotes(idx, e.target.value)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted-foreground">
                All items must be reviewed before submitting.
              </p>
              <Button
                onClick={handleSubmit}
                disabled={submitting || answers.length === 0}
                className={isAm ? "bg-sky-600 hover:bg-sky-700" : "bg-indigo-600 hover:bg-indigo-700"}
              >
                {submitting ? "Submitting…" : `Submit ${isAm ? "opening" : "closing"} checklist`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
