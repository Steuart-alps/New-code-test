import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import type { DepartmentRow } from "@/lib/departments";
import { sortByLabel } from "@/lib/sort-options";
import { PickOrTypeSelect, type PickGroup } from "@/components/pick-or-type-select";

/** The business's departments, as set up in Settings (each under a site, or every site). */
export function useDepartments() {
  const { activeClientId } = useAuth();
  return useQuery<DepartmentRow[]>({
    queryKey: ["/api/departments", activeClientId],
    queryFn: async () => {
      const response = await apiFetch("/departments");
      return response.ok ? response.json() : [];
    },
    staleTime: 60_000,
  });
}

/**
 * Department names to pick from: those set up for the site (or every site
 * when none is chosen), then names used elsewhere, such as on the Staff
 * Roster or earlier documents, that aren't set up at any site.
 */
export function departmentNameGroups(departments: DepartmentRow[], siteId: number | null, usedBefore: (string | null | undefined)[]): PickGroup[] {
  const atSite = departments
    .filter(d => siteId == null || d.siteId == null || d.siteId === siteId)
    .map(d => d.name.trim());
  const setUp = new Set(departments.map(d => d.name.trim()));
  const others = usedBefore.map(name => name?.trim() ?? "").filter(name => name && !setUp.has(name));
  const unique = (names: string[]) => sortByLabel(Array.from(new Set(names)), name => name);
  return [
    { label: "Your departments", options: unique(atSite) },
    { label: "Used before", options: unique(others) },
  ];
}

/**
 * A department dropdown for a text department field: a first "none" choice
 * (e.g. "All departments"), the departments set up for the chosen site, names
 * used before, and "Other" to type a new one.
 */
export function DepartmentNameSelect({
  id, value, onChange, siteId, usedBefore = [], noneLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** The site chosen on the form; null when the record isn't for one site. */
  siteId: number | null;
  usedBefore?: (string | null | undefined)[];
  noneLabel: string;
}) {
  const { data: departments = [] } = useDepartments();
  return (
    <PickOrTypeSelect
      id={id}
      value={value}
      onChange={onChange}
      groups={departmentNameGroups(departments, siteId, usedBefore)}
      noneLabel={noneLabel}
      otherLabel="Other (type a new department)"
      typedPlaceholder="Department name"
      typedLabel="Department name"
    />
  );
}
