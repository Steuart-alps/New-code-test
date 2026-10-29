import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListSites } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import type { DepartmentRow } from "@/lib/departments";

const storageKey = (clientId: number | null | undefined) => `complytrack.checklist-site.${clientId ?? "own"}`;

function readRemembered(clientId: number | null | undefined): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey(clientId));
    const id = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function remember(clientId: number | null | undefined, siteId: number | null) {
  try {
    if (siteId) window.localStorage.setItem(storageKey(clientId), String(siteId));
  } catch { /* Private browsing: the choice just isn't remembered. */ }
}

function siteFromUrl(): number | null {
  const id = Number(new URLSearchParams(window.location.search).get("siteId"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The site a daily checklist page starts on, so nobody has to pick one (and a
 * checklist is never saved against no site, which counts for no site). In
 * order: the page link's ?siteId=, the site of the user's own department, the
 * site last picked on this device, then the first site. The choice can still
 * be changed; it is kept in the address and remembered on this device.
 */
export function useChecklistSite() {
  const { user, activeClientId } = useAuth();
  const clientId = activeClientId ?? user?.clientId;
  const { data: sites = [], isLoading: sitesLoading } = useListSites();
  const [chosen, setChosen] = useState<number | null | undefined>(() => siteFromUrl() ?? undefined);

  const needDepartment = chosen === undefined && sites.length > 1 && !!user?.departmentId;
  const departments = useQuery<DepartmentRow[]>({
    queryKey: ["departments", "checklist-site", clientId],
    enabled: needDepartment,
    queryFn: async () => {
      const response = await apiFetch("/departments");
      return response.ok ? response.json() : [];
    },
  });

  const fallback = useMemo(() => {
    if (sites.length === 0) return null;
    const known = (id: number | null | undefined) => (id && sites.some(s => s.id === id) ? id : null);
    const departmentSite = departments.data?.find(d => d.id === user?.departmentId)?.siteId;
    return known(departmentSite) ?? known(readRemembered(clientId)) ?? sites[0].id;
  }, [sites, departments.data, user?.departmentId, clientId]);

  const ready = chosen !== undefined || (!sitesLoading && !(needDepartment && departments.isLoading));
  const siteId = chosen !== undefined ? chosen : ready ? fallback : null;

  const setSiteId = (id: number | null) => {
    setChosen(id);
    remember(clientId, id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("siteId", String(id)); else url.searchParams.delete("siteId");
    window.history.replaceState(window.history.state, "", url);
  };

  return { sites, siteId, setSiteId, ready };
}
