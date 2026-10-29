import { MapPin } from "lucide-react";
import { useWorkingSite } from "@/hooks/use-working-site";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const ALL = "all";

/**
 * The site the user is working at, for anyone who works across more than one
 * site. Every track then starts on it (page filters and new records); the
 * site can still be changed on each page. An Owner picks it at the start.
 */
export function WorkingSiteSwitcher() {
  const { siteId, sites, everySite, needsChoice, setSiteId } = useWorkingSite();
  if (sites.length < 2) return null;
  return (
    <Select value={siteId ? String(siteId) : needsChoice ? "" : ALL} onValueChange={value => setSiteId(value === ALL ? null : Number(value))}>
      <SelectTrigger
        className={cn("h-9 w-auto max-w-[11rem] gap-1.5 text-xs sm:text-sm", needsChoice && "border-amber-400 bg-amber-50")}
        aria-label="Site you're working at"
        data-testid="working-site-switcher"
      >
        <MapPin className="h-4 w-4 shrink-0 text-primary" />
        <SelectValue placeholder="Choose your site" />
      </SelectTrigger>
      <SelectContent>
        {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
        {everySite && <SelectItem value={ALL}>All sites</SelectItem>}
      </SelectContent>
    </Select>
  );
}
