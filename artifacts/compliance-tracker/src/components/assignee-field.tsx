import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sortByLabel } from "@/lib/sort-options";

/**
 * "Assigned to" for an action, FixTrack issue or compliance check: a person
 * from the business (their reminders then reach them), or a typed name for
 * someone without an account (shown, but nobody is reminded).
 */
export interface AssigneeValue {
  assigneeUserId: number | null;
  name: string;
}

export const emptyAssignee: AssigneeValue = { assigneeUserId: null, name: "" };

interface Person { id: number; name: string; role: string }

const NONE = "none";
const TYPED = "typed";

/** The request fields for a value: the person, or the typed name with no person. */
export function assigneeFields(value: AssigneeValue, nameField: "ownerName" | "assignedTo") {
  return value.assigneeUserId != null
    ? { assigneeUserId: value.assigneeUserId }
    : { assigneeUserId: null, [nameField]: value.name.trim() || null };
}

export function AssigneeField({ id, siteId, value, onChange, disabled }: {
  id: string;
  siteId: number | null;
  value: AssigneeValue;
  onChange: (value: AssigneeValue) => void;
  disabled?: boolean;
}) {
  const { data: people = [], isLoading } = useQuery({
    queryKey: ["assignees", siteId],
    queryFn: async (): Promise<Person[]> => {
      const response = await apiFetch(`/assignees${siteId != null ? `?siteId=${siteId}` : ""}`);
      if (!response.ok) return [];
      return response.json();
    },
    staleTime: 60_000,
  });
  // A typed name, or a person who can no longer be picked here, keeps showing.
  const [typing, setTyping] = useState(value.assigneeUserId == null && value.name.trim() !== "");
  const picked = value.assigneeUserId != null ? people.find((person) => person.id === value.assigneeUserId) : undefined;
  const selected = value.assigneeUserId != null
    ? String(value.assigneeUserId)
    : typing || value.name.trim() ? TYPED : NONE;
  return (
    <div className="space-y-2">
      <Select
        value={selected}
        disabled={disabled || isLoading}
        onValueChange={(next) => {
          setTyping(next === TYPED);
          if (next === NONE) onChange(emptyAssignee);
          else if (next === TYPED) onChange({ assigneeUserId: null, name: value.assigneeUserId != null ? "" : value.name });
          else {
            const person = people.find((candidate) => String(candidate.id) === next);
            if (person) onChange({ assigneeUserId: person.id, name: person.name });
          }
        }}
      >
        <SelectTrigger id={id}><SelectValue placeholder="Not assigned" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not assigned</SelectItem>
          {sortByLabel(people, (person) => person.name).map((person) => <SelectItem key={person.id} value={String(person.id)}>{person.name}</SelectItem>)}
          {value.assigneeUserId != null && !picked && (
            <SelectItem value={String(value.assigneeUserId)}>{value.name || "Former member"}</SelectItem>
          )}
          <SelectItem value={TYPED}>Someone without an account…</SelectItem>
        </SelectContent>
      </Select>
      {selected === TYPED && (
        <Input
          aria-label="Name of the person responsible"
          disabled={disabled}
          value={value.name}
          onChange={(event) => onChange({ assigneeUserId: null, name: event.target.value })}
          placeholder="Name (they won't get reminders)"
        />
      )}
      {selected === TYPED && <p className="text-xs text-muted-foreground">Reminders for this go to the track's owner instead.</p>}
    </div>
  );
}
