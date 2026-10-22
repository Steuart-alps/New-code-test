import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { ensureOk } from "@/components/register-shared";
import { ALLERGENS, ALLERGEN_SHORT } from "@/lib/allergens";

// Pieces shared by the allergen dishes, ingredients and charts tabs.

/**
 * One row per allergen with "Contains" and "May contain" ticks. Ticking
 * "Contains" clears "May contain" for that allergen, as the API does.
 */
export function AllergenTicks({ contains, mayContain, onChange, idPrefix }: {
  contains: string[];
  mayContain: string[];
  onChange: (next: { contains: string[]; mayContain: string[] }) => void;
  idPrefix: string;
}) {
  function set(key: string, kind: "contains" | "may", checked: boolean) {
    const nextContains = contains.filter((k) => k !== key);
    const nextMay = mayContain.filter((k) => k !== key);
    if (checked && kind === "contains") nextContains.push(key);
    if (checked && kind === "may") nextMay.push(key);
    onChange({ contains: nextContains, mayContain: nextMay });
  }
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs">
          <tr>
            <th className="text-left font-medium p-2">Allergen</th>
            <th className="font-medium p-2 w-24">Contains</th>
            <th className="font-medium p-2 w-24">May contain</th>
          </tr>
        </thead>
        <tbody>
          {ALLERGENS.map((a) => (
            <tr key={a.key} className="border-t border-border">
              <td className="p-2">{a.label}</td>
              <td className="p-2 text-center">
                <Checkbox id={`${idPrefix}-c-${a.key}`} aria-label={`Contains ${a.label}`}
                  checked={contains.includes(a.key)} onCheckedChange={(checked) => set(a.key, "contains", checked === true)} />
              </td>
              <td className="p-2 text-center">
                <Checkbox id={`${idPrefix}-m-${a.key}`} aria-label={`May contain ${a.label}`}
                  checked={mayContain.includes(a.key)} onCheckedChange={(checked) => set(a.key, "may", checked === true)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Red badges for "contains", amber for "may contain". */
export function AllergenBadges({ contains, mayContain, emptyText = "None of the 14 allergens" }: {
  contains: string[];
  mayContain: string[];
  emptyText?: string;
}) {
  if (contains.length === 0 && mayContain.length === 0) return <span className="text-xs text-muted-foreground">{emptyText}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {contains.map((k) => <Badge key={k} variant="outline" className="text-[11px] border-red-200 bg-red-50 text-red-700">{ALLERGEN_SHORT[k] ?? k}</Badge>)}
      {mayContain.map((k) => (
        <Badge key={`m-${k}`} variant="outline" className="text-[11px] border-amber-300 bg-amber-50 text-amber-800">May: {ALLERGEN_SHORT[k] ?? k}</Badge>
      ))}
    </div>
  );
}

export interface AllergenChangeRow {
  id: number;
  changeType: "created" | "allergens_changed" | "removed";
  before: string[] | null;
  after: string[] | null;
  mayBefore: string[] | null;
  mayAfter: string[] | null;
  reason: string | null;
  changedByName: string | null;
  createdAt: string;
  dishesUpdated?: number;
}

function names(keys: string[]) {
  return keys.map((k) => ALLERGEN_SHORT[k] ?? k).join(", ");
}

function describe(change: AllergenChangeRow, removedText: string) {
  if (change.changeType === "created") {
    const may = change.mayAfter ?? [];
    return `Added with: ${names(change.after ?? []) || "no allergens"}${may.length ? ` · may contain ${names(may)}` : ""}`;
  }
  if (change.changeType === "removed") return removedText;
  const diff = (before: string[] | null, after: string[] | null) => ({
    added: (after ?? []).filter((k) => !(before ?? []).includes(k)),
    removed: (before ?? []).filter((k) => !(after ?? []).includes(k)),
  });
  const c = diff(change.before, change.after);
  const parts = [c.added.length ? `Added: ${names(c.added)}` : "", c.removed.length ? `Removed: ${names(c.removed)}` : ""];
  // Older rows have no may-contain columns; only compare when both are recorded.
  if (change.mayBefore && change.mayAfter) {
    const m = diff(change.mayBefore, change.mayAfter);
    parts.push(m.added.length ? `May contain added: ${names(m.added)}` : "", m.removed.length ? `May contain removed: ${names(m.removed)}` : "");
  }
  return parts.filter(Boolean).join(" · ") || "Allergens changed";
}

/** Change log for a dish or an ingredient. */
export function AllergenChangeLogDialog({ title, path, removedText, normalise, onClose }: {
  title: string | null;
  path: string | null;
  removedText: string;
  normalise: (row: Record<string, unknown>) => AllergenChangeRow;
  onClose: () => void;
}) {
  const api = useActiveClientApi();
  const { activeClientId } = useAuth();
  const { data: changes = [], isLoading, error } = useQuery<AllergenChangeRow[]>({
    queryKey: [`/api${path}`, activeClientId],
    enabled: path !== null,
    queryFn: async () => {
      const rows: Record<string, unknown>[] = await (await ensureOk(await api(path!), "Could not load the change log")).json();
      return rows.map(normalise);
    },
  });
  return (
    <Dialog open={path !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Change log: {title}</DialogTitle>
          <DialogDescription>Each allergen change is kept with the reason given.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-2">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
          {changes.map((change) => (
            <div key={change.id} className="rounded-md border border-border p-3 text-sm space-y-1">
              <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>{format(new Date(change.createdAt), "d MMM yyyy, HH:mm")}</span>
                <span>{change.changedByName ?? "Unknown user"}</span>
              </div>
              <p className="font-medium">{describe(change, removedText)}</p>
              {change.reason && <p className="text-muted-foreground">Reason: {change.reason}</p>}
              {!!change.dishesUpdated && (
                <p className="text-xs text-muted-foreground">{change.dishesUpdated} dish{change.dishesUpdated === 1 ? "" : "es"} updated</p>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
