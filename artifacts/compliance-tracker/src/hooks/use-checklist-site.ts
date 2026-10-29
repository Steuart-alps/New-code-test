import { useState } from "react";
import { useListSites } from "@workspace/api-client-react";
import { useWorkingSite } from "@/hooks/use-working-site";

function siteFromUrl(): number | null {
  const id = Number(new URLSearchParams(window.location.search).get("siteId"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The site a daily checklist page starts on, so nobody has to pick one (and a
 * checklist is never saved against no site, which counts for no site). In
 * order: the page link's ?siteId=, the user's working site (see
 * useWorkingSite), then the first of their sites. The choice can still be
 * changed; it is kept in the address and becomes their working site.
 */
export function useChecklistSite() {
  const working = useWorkingSite();
  const { data: sites = [] } = useListSites();
  const [chosen, setChosen] = useState<number | null | undefined>(() => siteFromUrl() ?? undefined);

  const fallback = sites.length === 0 ? null
    : working.siteId && sites.some(s => s.id === working.siteId) ? working.siteId
    : (working.sites[0] ?? sites[0]).id;
  const ready = chosen !== undefined || working.ready;
  const siteId = chosen !== undefined ? chosen : ready ? fallback : null;

  const setSiteId = (id: number | null) => {
    setChosen(id);
    working.setSiteId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("siteId", String(id)); else url.searchParams.delete("siteId");
    window.history.replaceState(window.history.state, "", url);
  };

  return { sites, siteId, setSiteId, ready };
}
