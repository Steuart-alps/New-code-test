import type { KeyboardEvent } from "react";
import { CheckSquare, Square } from "lucide-react";
import { Input } from "@/components/ui/input";

export interface ChecklistRowItem { label: string; checked: boolean; notes?: string }

/**
 * One tickable line of a daily checklist. The tick target is a real
 * keyboard-operable checkbox (Tab to focus, Space or Enter to toggle).
 */
export function ChecklistItemRow({ item, submitted, onToggle, onNote }: {
  item: ChecklistRowItem;
  submitted: boolean;
  onToggle: () => void;
  onNote: (note: string) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <div className={`rounded-lg border p-3 transition-colors ${submitted ? "bg-muted/20 opacity-80" : "hover:bg-muted/20 cursor-pointer"} ${item.checked ? "border-emerald-200 bg-emerald-50/50" : "border-border"}`}>
      <div
        role="checkbox"
        aria-checked={item.checked}
        aria-disabled={submitted || undefined}
        tabIndex={submitted ? -1 : 0}
        className="flex items-start gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={onToggle}
        onKeyDown={onKeyDown}
      >
        {item.checked
          ? <CheckSquare aria-hidden="true" className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
          : <Square aria-hidden="true" className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />}
        <span className={`text-sm ${item.checked ? "text-emerald-800 line-through decoration-emerald-400" : ""}`}>{item.label}</span>
      </div>
      {!submitted && item.checked && (
        <div className="mt-2 ml-7">
          <Input
            value={item.notes ?? ""}
            onChange={e => onNote(e.target.value)}
            placeholder="Optional note…"
            aria-label={`Note for ${item.label}`}
            className="h-7 text-xs bg-white"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
      {submitted && item.notes && <p className="ml-7 mt-1 text-xs text-muted-foreground italic">{item.notes}</p>}
    </div>
  );
}
