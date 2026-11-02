import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sortByLabel } from "@/lib/sort-options";

export interface PickGroup {
  /** Heading shown above the group's options. */
  label?: string;
  options: string[];
}

const TYPED = "__typed__";
const NONE = "__none__";

/**
 * A dropdown of the usual answers, with a last "Other" choice that opens a box
 * to type in. The value is plain text, so a value typed before the dropdown
 * existed (or one no longer in the list) still shows, in the box. With
 * `noneLabel`, a first choice such as "All departments" stands for no value.
 */
export function PickOrTypeSelect({
  id, value, onChange, groups, placeholder = "Choose…", otherLabel = "Other (type it in)",
  typedPlaceholder, typedLabel, disabled, noneLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  groups: PickGroup[];
  placeholder?: string;
  otherLabel?: string;
  typedPlaceholder?: string;
  /** Accessible name of the box for typing; defaults to the placeholder. */
  typedLabel?: string;
  disabled?: boolean;
  /** A first choice that clears the value, e.g. "All departments". */
  noneLabel?: string;
}) {
  // One option per text, in the first group that lists it.
  const seen = new Set<string>();
  const shown = groups.map((group) => ({
    label: group.label,
    options: group.options.filter((option) => option.trim() && !seen.has(option) && seen.add(option)),
  })).filter((group) => group.options.length > 0);
  const listed = seen.has(value);
  const [typing, setTyping] = useState(false);
  const showTyped = typing || (value.trim() !== "" && !listed);
  const box = useRef<HTMLInputElement>(null);
  // After "Other" is picked the cursor goes to the box, not back to the dropdown.
  const focusBox = useRef(false);

  return (
    <div className="space-y-2">
      <Select
        value={showTyped ? TYPED : listed ? value : noneLabel ? NONE : ""}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === TYPED) {
            setTyping(true);
            focusBox.current = true;
            if (listed) onChange("");
          } else if (next === NONE) {
            setTyping(false);
            onChange("");
          } else {
            setTyping(false);
            onChange(next);
          }
        }}
      >
        <SelectTrigger id={id}><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent
          onCloseAutoFocus={(event) => {
            if (!focusBox.current) return;
            focusBox.current = false;
            event.preventDefault();
            box.current?.focus();
          }}
        >
          {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
          {noneLabel && shown.length > 0 && <SelectSeparator />}
          {shown.map((group, index) => (
            <SelectGroup key={group.label ?? index}>
              {index > 0 && <SelectSeparator />}
              {group.label && <SelectLabel>{group.label}</SelectLabel>}
              {group.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
            </SelectGroup>
          ))}
          {shown.length > 0 && <SelectSeparator />}
          <SelectItem value={TYPED}>{otherLabel}</SelectItem>
        </SelectContent>
      </Select>
      {showTyped && (
        <Input
          ref={box}
          aria-label={typedLabel ?? typedPlaceholder}
          disabled={disabled}
          value={value}
          placeholder={typedPlaceholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

interface Person { id: number; name: string }
interface Contractor { id: number; name: string; company?: string | null }

/** How a contractor reads in a list: their name, then their company. */
export function contractorLabel(contractor: Contractor): string {
  const company = contractor.company?.trim();
  return company && company.toLowerCase() !== contractor.name.trim().toLowerCase()
    ? `${contractor.name.trim()}, ${company}` : contractor.name.trim();
}

/**
 * The business's people with a login, then its contractors, A to Z: the
 * groups for picking who owns or does something. A list that cannot be read
 * (a viewer has no people list) or is empty is left out.
 */
export function usePeopleAndContractors(enabled = true): PickGroup[] {
  const { data: people = [] } = useQuery({
    queryKey: ["assignees", null],
    queryFn: async (): Promise<Person[]> => {
      const response = await apiFetch("/assignees");
      return response.ok ? response.json() : [];
    },
    enabled,
    staleTime: 60_000,
  });
  const { data: contractors = [] } = useQuery({
    queryKey: ["contractor-names"],
    queryFn: async (): Promise<Contractor[]> => {
      const response = await apiFetch("/contractors");
      return response.ok ? response.json() : [];
    },
    enabled,
    staleTime: 60_000,
  });
  return [
    { label: "People with a login", options: sortByLabel(people.map((person) => person.name), (name) => name) },
    {
      label: "Contractors",
      options: sortByLabel(contractors.map(contractorLabel), (name) => name),
    },
  ];
}
