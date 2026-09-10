import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Label } from "@/components/ui/label";

export interface StaffPerformer {
  id: number;
  name: string;
  active?: boolean;
}

interface StaffPerformerSelectProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** Receives the selected roster id; null means free-text/cleared. */
  onRosterIdChange?: (value: number | null) => void;
  label?: string;
  optional?: boolean;
  placeholder?: string;
  className?: string;
}

/** Staff roster picker used for frontline records. Existing free-text values remain editable. */
export function StaffPerformerSelect({
  value,
  onChange,
  onRosterIdChange,
  label = "Performed by",
  optional = false,
  placeholder = "Select a staff member",
  className,
}: StaffPerformerSelectProps) {
  const [staff, setStaff] = useState<StaffPerformer[]>([]);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/staff-roster")
      .then((response) => response.ok ? response.json() : [])
      .then((members: StaffPerformer[]) => {
        if (!cancelled) {
          const active = (Array.isArray(members) ? members : []).filter((member) => member.active !== false);
          setStaff(active);
          setCustom(Boolean(value) && !active.some((member) => member.name === value));
        }
      })
      .catch(() => { /* The free-text fallback remains available if the roster is unavailable. */ });
    return () => { cancelled = true; };
  // Load once per form instance; changing custom text must not switch the
  // control back to the roster placeholder on every keystroke.
  }, []);

  const selected = custom ? "__custom__" : String(staff.find((member) => member.name === value)?.id ?? "");
  return (
    <div className={className}>
      <Label>{label} {optional && <span className="text-muted-foreground text-xs">optional</span>}</Label>
      <select
        value={selected}
        onChange={(event) => {
          if (event.target.value === "__custom__") {
            setCustom(true);
            onRosterIdChange?.(null);
            onChange("");
          } else {
            setCustom(false);
            const member = staff.find((candidate) => candidate.id === Number(event.target.value));
            onRosterIdChange?.(member?.id ?? null);
            onChange(member?.name ?? "");
          }
        }}
        className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        data-testid="select-performed-by"
      >
        <option value="">{placeholder}</option>
        {staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        <option value="__custom__">Other / enter name…</option>
      </select>
      {custom && (
        <input
          value={value ?? ""}
           onChange={(event) => {
             // Once text is edited it is explicitly custom, even when the
             // roster id was previously selected. This also deliberately
             // sends null (rather than leaving an omitted id) to the API.
             onRosterIdChange?.(null);
             onChange(event.target.value);
           }}
          placeholder="Name"
          className="mt-2 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          data-testid="input-performed-by-custom"
        />
      )}
    </div>
  );
}