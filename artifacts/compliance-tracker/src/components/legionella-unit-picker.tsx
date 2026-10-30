import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanManageUsers } from "@/context/auth-context";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { sortByLabel } from "@/lib/sort-options";

/**
 * Cold water tanks and calorifiers come from the Equipment & QR labels list,
 * where each one has the name the business gives it ("Tank 1, roof void").
 * A site can have several, so tank and calorifier checks say which one.
 */
export type LegionellaUnit = { id: number; name: string; location: string | null; siteId: number | null; type: string; active: boolean };
type UnitType = "cold_water_tank" | "calorifier";

// Mirrors EQUIPMENT_CHECK_TYPES in api-server routes/legionella.ts.
const UNIT_TYPE_FOR_CHECK: Record<string, UnitType> = {
  cold_tank_temp: "cold_water_tank", cold_tank_inspection: "cold_water_tank", cold_tank_clean: "cold_water_tank",
  calorifier_temp: "calorifier", calorifier_inspection: "calorifier", calorifier_clean: "calorifier",
};
const UNIT_WORDS: Record<UnitType, { one: string; example: string }> = {
  cold_water_tank: { one: "tank", example: "e.g. Tank 1 (roof void)" },
  calorifier: { one: "calorifier", example: "e.g. Main calorifier" },
};

export function legionellaUnitType(checkType: string): UnitType | null {
  return UNIT_TYPE_FOR_CHECK[checkType] ?? null;
}

export function legionellaUnitLabel(unit: Pick<LegionellaUnit, "name" | "location">): string {
  return unit.location && unit.location !== unit.name ? `${unit.name} (${unit.location})` : unit.name;
}

/** Every tank and calorifier the user can see, archived ones too so history keeps their names. */
export function useLegionellaUnits() {
  const { activeClientId } = useAuth();
  return useQuery<LegionellaUnit[]>({
    queryKey: ["equipment", activeClientId, "legionella-units"],
    queryFn: async () => {
      const response = await apiFetch("/equipment?includeArchived=true");
      if (!response.ok) return [];
      const items = (await response.json()) as LegionellaUnit[];
      return items.filter(item => item.type === "cold_water_tank" || item.type === "calorifier");
    },
    enabled: !!activeClientId,
  });
}

/** The active tanks (or calorifiers) at a site that this check type is made on. */
export function siteUnitsFor(units: LegionellaUnit[] | undefined, checkType: string, siteId: number | undefined): LegionellaUnit[] {
  const type = legionellaUnitType(checkType);
  if (!type || !units) return [];
  return sortByLabel(units.filter(u => u.active && u.type === type && (u.siteId ?? undefined) === siteId), u => u.name);
}

/** "Which tank?": pick one of the site's named tanks, or name a new one. */
export function LegionellaUnitPicker({ checkType, siteId, units, value, onChange }: {
  checkType: string;
  siteId: number | undefined;
  units: LegionellaUnit[];
  value: number | null;
  onChange: (unit: LegionellaUnit | null) => void;
}) {
  const type = legionellaUnitType(checkType);
  const canAdd = useCanManageUsers();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  if (!type) return null;
  const words = UNIT_WORDS[type];

  const addUnit = async () => {
    if (!name.trim()) {
      toast({ title: `Give the ${words.one} a name`, variant: "destructive" });
      return;
    }
    setSaving(true);
    const response = await apiFetch("/equipment", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), type, siteId: siteId ?? null, location: location.trim() || null }),
    });
    setSaving(false);
    if (!response.ok) {
      toast({ title: `Could not add the ${words.one}`, description: await getApiErrorMessage(response, "Please try again."), variant: "destructive" });
      return;
    }
    const created = (await response.json()) as LegionellaUnit;
    await queryClient.invalidateQueries({ queryKey: ["equipment"] });
    onChange(created);
    setAdding(false);
    setName("");
    setLocation("");
  };

  return (
    <div className="space-y-1.5" data-testid="legionella-unit-picker">
      <Label>Which {words.one}?</Label>
      {units.length > 0 && (
        <Select value={value ? String(value) : ""} onValueChange={v => onChange(units.find(u => String(u.id) === v) ?? null)}>
          <SelectTrigger aria-label={`Which ${words.one}?`}><SelectValue placeholder={`Choose the ${words.one}`} /></SelectTrigger>
          <SelectContent>
            {units.map(unit => <SelectItem key={unit.id} value={String(unit.id)}>{legionellaUnitLabel(unit)}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {units.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">
          No {words.one}s are named for this site yet.{canAdd ? ` Add each ${words.one} so every record says which one it was.` : " A Manager or Owner can add them."}
        </p>
      )}
      {adding ? (
        <div className="space-y-2 rounded-sm border px-3 py-3">
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={words.example} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Where it is (optional)</Label>
            <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Clubhouse loft" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={addUnit} disabled={saving}>{saving ? "Adding…" : `Add ${words.one}`}</Button>
          </div>
        </div>
      ) : canAdd && (
        <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => setAdding(true)}>
          <Plus className="w-3 h-3 mr-1" /> Add a {words.one}
        </Button>
      )}
    </div>
  );
}
