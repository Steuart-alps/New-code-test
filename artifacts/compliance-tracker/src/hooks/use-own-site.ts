import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import type { DepartmentRow } from "@/lib/departments";

/**
 * The site of the signed-in user's own department, or null for an Owner or
 * Consultant (who look across every site), a user without a department, or a
 * department that spans every site.
 */
export function useOwnSiteId(): number | null {
  const { user, activeClientId } = useAuth();
  const departmentId = user?.departmentId ?? null;
  const looksAcrossSites = !user || user.role === "consultant" || user.role === "client_admin";
  const departments = useQuery<DepartmentRow[]>({
    queryKey: ["departments", "own-site", activeClientId ?? user?.clientId ?? null],
    enabled: !looksAcrossSites && departmentId != null,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const response = await apiFetch("/departments");
      return response.ok ? response.json() : [];
    },
  });
  if (looksAcrossSites || departmentId == null) return null;
  return departments.data?.find(d => d.id === departmentId)?.siteId ?? null;
}

/**
 * A page's site filter. It starts on the user's own site (see useOwnSiteId);
 * an Owner or Consultant, or anyone without a site of their own, starts on
 * `allValue` ("All sites") as before. Once the user picks a value it stays.
 */
export function useSiteFilter<T extends string>(allValue: T): [string, (value: string) => void] {
  const ownSiteId = useOwnSiteId();
  const [chosen, setChosen] = useState<string | null>(null);
  return [chosen ?? (ownSiteId ? String(ownSiteId) : allValue), setChosen];
}

/** useSiteFilter for pages that keep the filter as a site id (undefined = all sites). */
export function useSiteFilterId(): [number | undefined, (value: number | undefined) => void] {
  const ownSiteId = useOwnSiteId();
  const [chosen, setChosen] = useState<{ value: number | undefined } | null>(null);
  return [chosen ? chosen.value : ownSiteId ?? undefined, value => setChosen({ value })];
}
