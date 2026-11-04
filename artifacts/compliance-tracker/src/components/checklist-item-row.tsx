import { Input } from "@/components/ui/input";
import { itemResult, type ChecklistResult, type ResultItem } from "@/lib/checklist-results";

export type ChecklistRowItem = ResultItem;

const OPTIONS: { value: ChecklistResult; label: string; active: string }[] = [
  { value: "pass", label: "Pass", active: "border-emerald-600 bg-emerald-600 text-white" },
  { value: "fail", label: "Fail", active: "border-red-600 bg-red-600 text-white" },
  { value: "na", label: "N/A", active: "border-slate-500 bg-slate-500 text-white" },
];

const ROW_STYLE: Record<ChecklistResult, string> = {
  pass: "border-emerald-200 bg-emerald-50/50",
  fail: "border-red-200 bg-red-50/60",
  na: "border-slate-200 bg-slate-50",
};

/**
 * One line of a daily checklist, answered Pass, Fail or N/A. A failed item
 * needs a note saying what is wrong; it becomes an action and a FixTrack job
 * when the checklist is submitted.
 */
export function ChecklistItemRow({ item, submitted, onResult, onNote }: {
  item: ChecklistRowItem;
  submitted: boolean;
  onResult: (result: ChecklistResult) => void;
  onNote: (note: string) => void;
}) {
  const result = itemResult(item);
  return (
    <div className={`rounded-lg border p-3 transition-colors ${submitted ? "opacity-90" : ""} ${result ? ROW_STYLE[result] : "border-border"}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <span className="text-sm">{item.label}</span>
        <div role="radiogroup" aria-label={item.label} className="flex shrink-0 gap-1">
          {OPTIONS.map(option => {
            const selected = result === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={submitted}
                onClick={() => onResult(option.value)}
                className={`min-w-[3.25rem] rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${selected ? option.active : "border-border bg-white text-muted-foreground hover:bg-muted"} ${submitted && !selected ? "hidden" : ""}`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      {!submitted && result && (
        <div className="mt-2">
          <Input
            value={item.notes ?? ""}
            onChange={e => onNote(e.target.value)}
            placeholder={result === "fail" ? "What is wrong? (required)" : "Optional note…"}
            aria-label={`Note for ${item.label}`}
            aria-invalid={result === "fail" && !item.notes?.trim() ? true : undefined}
            className={`h-8 text-xs bg-white ${result === "fail" && !item.notes?.trim() ? "border-red-400" : ""}`}
          />
        </div>
      )}
      {submitted && item.notes && <p className="mt-1 text-xs text-muted-foreground italic">{item.notes}</p>}
    </div>
  );
}
