import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Site picker for the daily checklist pages. The page starts on a site (see
 * useChecklistSite); a business with no sites yet has nothing to pick.
 */
export function ChecklistSiteSelect({ sites, value, onChange }: {
  sites: { id: number; name: string }[];
  value: number | null;
  onChange: (siteId: number | null) => void;
}) {
  if (sites.length === 0) return null;
  return (
    <div className="space-y-1 flex-1 min-w-[180px]">
      <Label className="text-xs">Site</Label>
      <Select value={value ? String(value) : ""} onValueChange={v => onChange(v ? Number(v) : null)}>
        <SelectTrigger className="h-9" aria-label="Site"><SelectValue placeholder="Select site…" /></SelectTrigger>
        <SelectContent>
          {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
