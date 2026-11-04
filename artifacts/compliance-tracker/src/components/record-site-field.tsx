import { useEffect } from "react";
import { useListSites } from "@workspace/api-client-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWorkingSite } from "@/hooks/use-working-site";

/**
 * The sites a record form may save to. A record belongs to the site that's
 * selected, so one site can't create records for another (Steuart,
 * 4 Nov 2026: "limit to user own site for all tracks"):
 *
 * - The selected site is the page's site filter when it names a site, else
 *   the user's working site from the top bar (for Staff and Managers tied to
 *   a site, always their own). To record for another site, Owners and
 *   Consultants change the site there first.
 * - `keepSiteId` is a site the record already has (an edit, or a scanned QR
 *   label) and stays on the list, so opening a record never moves it.
 *
 * The server enforces the same for anyone tied to a site (middleware
 * ownSiteGate): they can only save to their own site.
 */
export function useRecordSites(pageSiteId?: number | null, keepSiteId?: number | null) {
  const { data: allSites = [] } = useListSites();
  const { siteId: workingSiteId, ready } = useWorkingSite();
  const selected = pageSiteId ?? workingSiteId ?? null;
  const sites = selected == null
    // Only a business without sites (or one still loading) has no selected site.
    ? allSites
    : allSites.filter(site => site.id === selected || (keepSiteId != null && site.id === keepSiteId));
  return { sites, selectedSiteId: selected, ready };
}

function toSiteId(value: number | string | null | undefined): number | undefined {
  const id = Number(value);
  return value != null && value !== "" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * The Site box on a record form: shows the selected site (see useRecordSites)
 * and, only when there's more than one choice, a dropdown. Renders nothing for
 * a business without sites.
 *
 * `businessWide` names the "no particular site" choice for records that can
 * cover the whole business (a policy document, say). Only Owners, Consultants
 * and every-department Managers get it; a record already saved without a site
 * keeps it too (pass keepSiteId null).
 */
export function RecordSiteField({
  value,
  onChange,
  pageSiteId,
  keepSiteId,
  businessWide,
  label = "Site",
  testId,
  className,
}: {
  value: number | string | null | undefined;
  onChange: (siteId: number | undefined) => void;
  pageSiteId?: number | null;
  keepSiteId?: number | null;
  businessWide?: string;
  label?: string;
  testId?: string;
  className?: string;
}) {
  const { data: allSites = [] } = useListSites();
  const { sites, selectedSiteId } = useRecordSites(pageSiteId, keepSiteId);
  const { sites: mySites, everySite } = useWorkingSite();
  const current = toSiteId(value);
  const allowNone = keepSiteId === null || (!!businessWide && everySite);
  const noneLabel = businessWide ?? "No specific site";
  const only = sites.length === 1 && !allowNone ? sites[0] : null;
  // Keep the form's value on a site this box offers (the working site can
  // load after the form opened, or change in the top bar while it's open).
  const offered = (current == null && allowNone) || sites.some(site => site.id === current);
  const fallback = sites.find(site => site.id === selectedSiteId)?.id ?? sites[0]?.id;
  useEffect(() => {
    if (allSites.length > 0 && !offered && fallback != null) onChange(fallback);
  }, [allSites.length, offered, fallback]); // eslint-disable-line react-hooks/exhaustive-deps
  if (allSites.length === 0) return null;
  if (only) {
    return (
      <div className={`space-y-1.5 ${className ?? ""}`}>
        <Label>{label}</Label>
        <div className="rounded-sm border bg-muted/40 px-3 py-2 text-sm" data-testid={testId}>
          <span className="font-medium">{only.name}</span>
          {mySites.length > 1 && (
            <p className="text-xs text-muted-foreground mt-0.5">Saved to the site you've selected. To record for another site, switch site at the top of the page first.</p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label>{label}</Label>
      <Select value={current ? String(current) : "none"} onValueChange={v => onChange(v === "none" ? undefined : Number(v))}>
        <SelectTrigger data-testid={testId}><SelectValue placeholder="Choose a site" /></SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value="none">{noneLabel}</SelectItem>}
          {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
