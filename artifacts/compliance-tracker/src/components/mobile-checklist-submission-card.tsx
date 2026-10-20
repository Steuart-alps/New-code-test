import { CheckSquare, Lock, Smartphone, Square } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface MobileChecklistSubmission {
  id: number;
  type: "am" | "pm";
  answers: Array<{ question: string; checked: boolean; notes?: string }>;
  submittedByName?: string | null;
  submittedAt?: string | null;
  signedOffByName?: string | null;
  signedOffAt?: string | null;
  signOffNotes?: string | null;
}

/**
 * The AM/PM checklist submitted from the mobile app for one site and day, if
 * any. Mobile checklists are a separate store; returns null when there is
 * none or it cannot be read (e.g. no site selected or the standalone
 * DailyTrack service is not enabled).
 */
export async function fetchMobileChecklistSubmission(
  siteId: number | null,
  date: string,
  period: "am" | "pm",
): Promise<MobileChecklistSubmission | null> {
  if (siteId == null) return null;
  try {
    const res = await apiFetch(`/daily-checklists/${siteId}/${date}/${period}`);
    if (!res.ok) return null;
    const body = await res.json() as { submission?: MobileChecklistSubmission | null };
    return body.submission?.submittedAt ? body.submission : null;
  } catch {
    return null;
  }
}

/** Read-only view of a checklist submitted from the mobile app. */
export function MobileChecklistSubmissionCard({ submission }: { submission: MobileChecklistSubmission }) {
  const checked = submission.answers.filter(a => a.checked).length;
  return (
    <Card className="p-5 bg-card shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-primary opacity-80" />
          <h3 className="font-semibold font-display">{submission.type === "am" ? "AM" : "PM"} checklist (mobile app)</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{checked}/{submission.answers.length}</span>
          <Badge className="bg-emerald-100 text-emerald-800 text-xs"><Lock className="w-3 h-3 mr-1" />Submitted</Badge>
        </div>
      </div>
      <ul className="space-y-1 mb-4">
        {submission.answers.map((answer, i) => (
          <li key={i} className={`rounded-lg border p-3 bg-muted/20 ${answer.checked ? "border-emerald-200" : "border-border"}`}>
            <div className="flex items-start gap-3">
              {answer.checked
                ? <CheckSquare aria-hidden="true" className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                : <Square aria-hidden="true" className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />}
              <span className="text-sm">
                <span className="sr-only">{answer.checked ? "Checked: " : "Not checked: "}</span>
                {answer.question}
              </span>
            </div>
            {answer.notes && <p className="ml-7 mt-1 text-xs text-muted-foreground italic">{answer.notes}</p>}
          </li>
        ))}
      </ul>
      <div className="border-t pt-3 space-y-1 text-xs text-muted-foreground">
        <p>
          Submitted{submission.submittedByName ? <> by <span className="font-medium">{submission.submittedByName}</span></> : null}
          {submission.submittedAt ? ` at ${new Date(submission.submittedAt).toLocaleString()}` : ""}
        </p>
        {submission.signedOffAt && (
          <p>
            Signed off{submission.signedOffByName ? <> by <span className="font-medium">{submission.signedOffByName}</span></> : null}
            {` at ${new Date(submission.signedOffAt).toLocaleString()}`}
            {submission.signOffNotes ? <> — <span className="italic">{submission.signOffNotes}</span></> : null}
          </p>
        )}
      </div>
    </Card>
  );
}
