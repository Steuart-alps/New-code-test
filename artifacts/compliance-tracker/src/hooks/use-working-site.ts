import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListSites } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import type { DepartmentRow } from "@/lib/departments";

// The site a user is working at is kept on this device, per business and
// user, and shared by every page (and other tabs) through this tiny store.
const listeners = new Set<() => void>();
const storageKey = (clientId: number | null, userId: number | undefined) =>
  `complytrack.working-site.${clientId ?? "own"}.${userId ?? "anon"}`;

function readStored(key: string): number | null {
  try {
    const id = Number(window.localStorage.getItem(key));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, siteId: number | null) {
  try {
    if (siteId) window.localStorage.setItem(key, String(siteId));
    else window.localStorage.removeItem(key);
  } catch { /* Private browsing: the choice lasts for this page only. */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/**
 * The site the signed-in user is working at, used as the default site on
 * every track: page filters start on it and new records are filled in with it
 * (the site can always be changed on the page).
 *
 * - Staff and Viewers: the site of their department.
 * - Managers (including Maintenance): the sites of the departments they look
 *   after; the one picked in the header (or on a checklist page) is kept,
 *   otherwise the site of the department they're working in.
 * - Owners, Consultants and Managers of every department: the site picked in
 *   the header; until one is picked, none (All sites).
 *
 * A department that spans every site (no site of its own) gives no default.
 */
export function useWorkingSite() {
  const { user, activeClientId } = useAuth();
  const clientId = activeClientId ?? user?.clientId ?? null;
  const { data: sites = [], isLoading: sitesLoading } = useListSites();
  const key = storageKey(clientId, user?.id);
  const stored = useSyncExternalStore(subscribe, () => readStored(key), () => null);

  const everySite = !user || user.role === "consultant" || user.role === "client_admin"
    || (user.role === "client_manager" && user.allDepartments === true);
  const departmentIds = user?.departmentIds?.length ? user.departmentIds : user?.departmentId ? [user.departmentId] : [];
  const needDepartments = !everySite && departmentIds.length > 0;
  const departments = useQuery<DepartmentRow[]>({
    queryKey: ["departments", "working-site", clientId],
    enabled: needDepartments,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const response = await apiFetch("/departments");
      return response.ok ? response.json() : [];
    },
  });

  const siteOf = (departmentId: number | null | undefined) =>
    departments.data?.find(d => d.id === departmentId)?.siteId ?? null;
  const ownSiteIds = new Set(departmentIds.map(siteOf));
  // Everyone may pick any site unless all their departments sit under sites.
  const mySites = everySite || departmentIds.length === 0 || ownSiteIds.has(null)
    ? sites
    : sites.filter(site => ownSiteIds.has(site.id));
  const isMine = (id: number | null) => id != null && mySites.some(site => site.id === id);

  let siteId: number | null = null;
  if (isMine(stored)) siteId = stored;
  else if (!everySite && isMine(siteOf(user?.departmentId))) siteId = siteOf(user?.departmentId);
  else if (mySites.length === 1) siteId = mySites[0].id;

  return {
    siteId,
    /** False until the sites (and the user's departments) have loaded. */
    ready: !sitesLoading && !(needDepartments && departments.isLoading),
    /** The sites this user works across (every site for an Owner). */
    sites: mySites,
    /** An Owner, Consultant or all-departments Manager: may work across All sites. */
    everySite,
    /** One of those hasn't picked a site yet. */
    needsChoice: everySite && siteId == null && sites.length > 1,
    setSiteId: (id: number | null) => writeStored(key, id),
  };
}

/** The default site for the signed-in user (see useWorkingSite), or null for none. */
export function useWorkingSiteId(): number | null {
  return useWorkingSite().siteId;
}

/**
 * A page's site filter. It starts on the user's working site (see
 * useWorkingSite), or on `allValue` ("All sites") when they have none. Once
 * the user picks a value on the page it stays while they're on it.
 */
export function useSiteFilter<T extends string>(allValue: T): [string, (value: string) => void] {
  const workingSiteId = useWorkingSiteId();
  const [chosen, setChosen] = useState<string | null>(null);
  return [chosen ?? (workingSiteId ? String(workingSiteId) : allValue), setChosen];
}

/** useSiteFilter for pages that keep the filter as a site id (undefined = all sites). */
export function useSiteFilterId(): [number | undefined, (value: number | undefined) => void] {
  const workingSiteId = useWorkingSiteId();
  const [chosen, setChosen] = useState<{ value: number | undefined } | null>(null);
  return [chosen ? chosen.value : workingSiteId ?? undefined, value => setChosen({ value })];
}
