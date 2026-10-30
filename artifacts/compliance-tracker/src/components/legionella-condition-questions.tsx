import {
  legionellaConditionQuestions,
  legionellaFindingFailures,
  legionellaFindingLines,
  type LegionellaFindings,
} from "@workspace/api-zod/legionella-condition";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Whether every condition question for this check type has an answer. */
export function legionellaFindingsComplete(checkType: string, findings: LegionellaFindings): boolean {
  return legionellaConditionQuestions(checkType).every(q => q.options.some(o => o.value === findings[q.key]));
}

/** The findings to send: only this check type's answers, or null when it has no questions. */
export function legionellaFindingsPayload(checkType: string, findings: LegionellaFindings): LegionellaFindings | null {
  const questions = legionellaConditionQuestions(checkType);
  if (questions.length === 0) return null;
  return Object.fromEntries(questions.filter(q => findings[q.key] != null).map(q => [q.key, findings[q.key]]));
}

/**
 * "What did you find?" for tank and calorifier inspections, cleans, shower
 * descales and outlet flushes: sediment, slime (biofilm), debris, lid and
 * screens. An answer that needs action turns the result to Fail, which opens
 * an action when the check is saved.
 */
export function LegionellaConditionQuestions({ checkType, findings, onChange }: {
  checkType: string;
  findings: LegionellaFindings;
  onChange: (findings: LegionellaFindings, needsAction: boolean) => void;
}) {
  const questions = legionellaConditionQuestions(checkType);
  if (questions.length === 0) return null;
  const failures = legionellaFindingFailures(checkType, findings);

  return (
    <div className="space-y-3 rounded-sm border px-3 py-3" data-testid="legionella-condition-questions">
      <div>
        <p className="text-sm font-medium">What did you find?</p>
        <p className="text-xs text-muted-foreground">Answer every question. After saving, add photos of any sediment or slime to the record as evidence.</p>
      </div>
      {questions.map(question => {
        const picked = question.options.find(o => o.value === findings[question.key]);
        return (
          <div key={question.key} className="space-y-1.5">
            <Label className="text-xs">{question.label}</Label>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={question.label}>
              {question.options.map(option => {
                const selected = picked?.value === option.value;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    size="sm"
                    role="radio"
                    aria-checked={selected}
                    variant={selected ? (option.fail ? "destructive" : "default") : "outline"}
                    className={cn("h-8 text-xs", !selected && option.fail && "text-red-700")}
                    onClick={() => {
                      const next = { ...findings, [question.key]: option.value };
                      onChange(next, legionellaFindingFailures(checkType, next).length > 0);
                    }}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
            {picked?.advice && <p className="text-xs text-amber-800">{picked.advice}</p>}
          </div>
        );
      })}
      {failures.length > 0 && (
        <div className="flex items-start gap-2 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>This needs action, so the check will be saved as a Fail and open an action for: {failures.map(f => f.split(": ")[0].toLowerCase()).join("; ")}.</span>
        </div>
      )}
    </div>
  );
}

/** The saved answers on a history row. */
export function LegionellaFindingsSummary({ checkType, findings }: { checkType: string; findings: unknown }) {
  const lines = legionellaFindingLines(checkType, findings);
  if (lines.length === 0) return null;
  const failures = new Set(legionellaFindingFailures(checkType, findings));
  return (
    <div>
      <span className="font-medium">Found:</span>
      <ul className="ml-4 list-disc">
        {lines.map(line => (
          <li key={line} className={cn(failures.has(line) && "text-red-700 font-medium")}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
