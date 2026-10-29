import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { sortByLabel } from "@/lib/sort-options";

export interface StaffPerformer {
  id: number;
  name: string;
  active?: boolean;
}

interface PerformerOption {
  key: string;
  name: string;
  /** The roster entry this name is linked to; null for a login with no roster entry. */
  rosterId: number | null;
}

interface StaffPerformerSelectProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** Receives the selected roster id; null means free-text/cleared. */
  onRosterIdChange?: (value: number | null) => void;
  /** Lists only the logins who can see this site; omit for the whole business. */
  siteId?: number | null;
  label?: string;
  optional?: boolean;
  placeholder?: string;
  className?: string;
}

const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Picker for who did a frontline record: the staff roster plus everyone with a
 * login for the business (Owners, Managers, Staff), so a Manager who isn't on
 * the roster can still be chosen. Existing free-text values remain editable.
 */
export function StaffPerformerSelect({
  value,
  onChange,
  onRosterIdChange,
  siteId,
  label = "Performed by",
  optional = false,
  placeholder = "Select a staff member",
  className,
}: StaffPerformerSelectProps) {
  const [roster, setRoster] = useState<StaffPerformer[] | null>(null);
  const [logins, setLogins] = useState<StaffPerformer[] | null>(null);
  const [custom, setCustom] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/staff-roster")
      .then((response) => response.ok ? response.json() : [])
      .then((members: StaffPerformer[]) => {
        if (!cancelled) setRoster((Array.isArray(members) ? members : []).filter((member) => member.active !== false));
      })
      // The free-text fallback remains available if the roster is unavailable.
      .catch(() => { if (!cancelled) setRoster([]); });
    return () => { cancelled = true; };
  // Load once per form instance; changing custom text must not switch the
  // control back to the roster placeholder on every keystroke.
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch(siteId ? `/assignees?siteId=${siteId}` : "/assignees")
      .then((response) => response.ok ? response.json() : [])
      .then((people: StaffPerformer[]) => { if (!cancelled) setLogins(Array.isArray(people) ? people : []); })
      .catch(() => { if (!cancelled) setLogins([]); });
    return () => { cancelled = true; };
  }, [siteId]);

  const options = useMemo<PerformerOption[]>(() => {
    const merged: PerformerOption[] = (roster ?? []).map((member) => ({ key: `r${member.id}`, name: member.name, rosterId: member.id }));
    const seen = new Set(merged.map((option) => nameKey(option.name)));
    for (const person of logins ?? []) {
      if (!person.name?.trim() || seen.has(nameKey(person.name))) continue;
      seen.add(nameKey(person.name));
      merged.push({ key: `u${person.id}`, name: person.name, rosterId: null });
    }
    return sortByLabel(merged, (option) => option.name);
  }, [roster, logins]);

  // Once both lists have loaded, a saved name that matches nobody opens as typed text.
  useEffect(() => {
    if (decided.current || roster === null || logins === null) return;
    decided.current = true;
    setCustom(Boolean(value) && !options.some((option) => option.name === value));
  }, [roster, logins, options, value]);

  const match = options.find((option) => option.name === value);
  // A picked login can drop out of the list when the site changes; keep showing
  // the name that will be saved rather than an empty placeholder.
  const stale = !custom && !match && Boolean(value) && roster !== null && logins !== null;
  const selected = custom ? "__custom__" : stale ? "__current__" : match?.key ?? "";
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
          } else if (event.target.value !== "__current__") {
            setCustom(false);
            const option = options.find((candidate) => candidate.key === event.target.value);
            onRosterIdChange?.(option?.rosterId ?? null);
            onChange(option?.name ?? "");
          }
        }}
        className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        data-testid="select-performed-by"
      >
        <option value="">{placeholder}</option>
        {stale && <option value="__current__">{value}</option>}
        {options.map((option) => <option key={option.key} value={option.key}>{option.name}</option>)}
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
