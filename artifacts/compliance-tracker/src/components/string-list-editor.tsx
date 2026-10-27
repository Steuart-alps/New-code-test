import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";

/**
 * A list of names edited one per line (alarm zones, incident locations,
 * kitchen items...). "Add" puts the cursor in the new line. Kept outside the
 * pages that use it: defined inside a page, it was rebuilt on every key press
 * and the box lost the cursor after each letter.
 */
export function StringListEditor({ items, onChange, placeholder, addLabel = "Add", kitchen = false }: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  addLabel?: string;
  /** KitchenTrack's look: a drag handle and a bin icon. */
  kitchen?: boolean;
}) {
  const newRow = useFocusNewRow();
  const RemoveIcon = kitchen ? Trash2 : X;
  return (
    <div ref={newRow.ref} className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex gap-2 items-center">
          {kitchen && <GripVertical className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
          <Input value={item} placeholder={placeholder} className="h-8 text-sm rounded-sm"
            onChange={e => { const n = [...items]; n[i] = e.target.value; onChange(n); }} />
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0"
            onClick={() => onChange(items.filter((_, x) => x !== i))}>
            <RemoveIcon className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => { newRow.expect(); onChange([...items, ""]); }}>
        <Plus className="w-3.5 h-3.5 mr-1.5" /> {addLabel}
      </Button>
    </div>
  );
}
