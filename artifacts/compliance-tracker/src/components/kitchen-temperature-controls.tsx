import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetFoodSafetyConfig, useListSites, parseKitchenTemperatureRules, kitchenTemperatureRulesSchema, temperatureRangeLabel, type KitchenTemperatureRules } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { ModuleActionsPanel } from "./module-actions-panel";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type RangeKey = "fridge" | "freezer" | "chilledDelivery" | "frozenDelivery" | "cooking" | "cooling" | "reheating" | "hotHolding" | "sousVide";
const labels: Record<RangeKey, string> = {
  fridge: "Fridges", freezer: "Freezers", chilledDelivery: "Chilled deliveries",
  frozenDelivery: "Frozen deliveries", cooking: "Cooking", cooling: "Cooling",
  reheating: "Reheating", hotHolding: "Hot holding", sousVide: "Sous vide",
};
const optionalInt = (value: string) => value === "" ? null : Number(value);
const holdFields = {
  cooking: { key: "holdSeconds", unit: "seconds", section: "Cooking" },
  sousVide: { key: "holdMinutes", unit: "minutes", section: "Sous vide" },
} as const;

/** Named items whose plan sets its own minimum core temperature and hold time. */
function ItemRules({ kind, rules, disabled, onChange }: {
  kind: "cooking" | "sousVide"; rules: KitchenTemperatureRules; disabled: boolean;
  onChange: (rules: KitchenTemperatureRules) => void;
}) {
  const { key, unit, section } = holdFields[kind];
  const items = rules.items[kind] as Array<{ item: string; min: number | null } & Record<string, unknown>>;
  const set = (next: typeof items) => onChange({ ...rules, items: { ...rules.items, [kind]: next } });
  return <fieldset className="space-y-2 rounded-sm border p-3">
    <legend className="px-1 text-sm font-medium">{section}: item rules</legend>
    <p className="text-xs text-muted-foreground">An item listed here uses its own minimum and hold time instead of the {section.toLowerCase()} values above. Leave a field blank for no numeric control.</p>
    {items.length === 0 && <p className="text-xs text-muted-foreground">No item rules.</p>}
    {items.map((entry, index) => <div key={index} className="grid grid-cols-[1fr_7rem_7rem_auto] items-center gap-2">
      <Input aria-label={`${section} item ${index + 1} name`} placeholder="Item name" disabled={disabled} value={entry.item}
        onChange={e => set(items.map((row, i) => i === index ? { ...row, item: e.target.value } : row))} />
      <Input aria-label={`${section} item ${index + 1} minimum °C`} type="number" step="0.1" placeholder="Min °C" disabled={disabled} value={entry.min ?? ""}
        onChange={e => set(items.map((row, i) => i === index ? { ...row, min: e.target.value === "" ? null : Number(e.target.value) } : row))} />
      <Input aria-label={`${section} item ${index + 1} hold ${unit}`} type="number" min={1} step="1" placeholder={`Hold ${unit}`} disabled={disabled} value={(entry[key] as number | null) ?? ""}
        onChange={e => set(items.map((row, i) => i === index ? { ...row, [key]: optionalInt(e.target.value) } : row))} />
      <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={`Remove ${entry.item || `${section} item ${index + 1}`}`}
        onClick={() => set(items.filter((_, i) => i !== index))}>Remove</Button>
    </div>)}
    {!disabled && <Button type="button" variant="outline" size="sm"
      onClick={() => set([...items, { item: "", min: rules[kind].min, [key]: (kind === "cooking" ? rules.cookingHoldSeconds : rules.sousVideHoldMinutes) }])}>Add item rule</Button>}
  </fieldset>;
}
export function KitchenTemperatureControls() {
  const { user, activeClientId } = useAuth();
  const manager = user?.role === "client_admin" || user?.role === "consultant";
  const queryClient = useQueryClient();
  const [siteId, setSiteId] = useState<number | null>(null);
  const { data: sites = [] } = useListSites();
  const { data: config, isLoading, isError } = useGetFoodSafetyConfig(siteId === null ? undefined : { siteId }, {
    query: { queryKey: ["food-safety-temperature-controls", activeClientId, siteId] },
  });
  const [rules, setRules] = useState<KitchenTemperatureRules | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setSiteId(null); setRules(null); setDirty(false); }, [activeClientId]);
  useEffect(() => {
    if (!config || dirty) return;
    try { setRules(parseKitchenTemperatureRules(config.food_temperature_rules)); setError(""); }
    catch { setRules(null); setError("Saved numeric rules could not be read. Ask an administrator to correct the configuration."); }
  }, [config, dirty]);
  async function save(inherit = false) {
    if (!rules) return;
    const valid = kitchenTemperatureRulesSchema.safeParse(rules);
    if (!inherit && !valid.success) { setError(valid.error.issues[0]?.message === "Each item can only have one rule" ? "Each item can only have one rule." : "Supply an ordered numeric range for every section, whole-number hold times and a name for each item rule."); return; }
    setSaving(true); setError("");
    try {
      const params = new URLSearchParams();
      if (siteId !== null) params.set("siteId", String(siteId));
      if (activeClientId !== null) params.set("clientId", String(activeClientId));
      const response = await apiFetch(`/food-safety/config?${params}`, {
        method: "PUT", body: JSON.stringify({ food_temperature_rules: inherit ? null : JSON.stringify(valid.data) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Rules could not be saved");
      setDirty(false);
      await queryClient.invalidateQueries({ predicate: q => String(q.queryKey[0]).includes("food-safety") });
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Rules could not be saved"); }
    finally { setSaving(false); }
  }
  return <div className="space-y-4">
    <details className="rounded-sm border bg-card p-4">
      <summary className="cursor-pointer font-medium">Numeric temperature controls</summary>
      <p className="my-3 text-sm text-muted-foreground">These numeric rules, not the legacy descriptive labels, determine failed readings. Confirm them against your site’s food-safety plan; they do not certify compliance. Limits are inclusive. When a hold time is set, staff must record how long each item was held at its core temperature.</p>
      <label className="block text-sm font-medium">Rules for
        <select className="mx-2 rounded border p-2" value={siteId ?? ""} disabled={saving} onChange={e => {
          if (dirty && !window.confirm("Discard unsaved numeric-rule changes?")) return;
          setRules(null); setDirty(false); setSiteId(e.target.value ? Number(e.target.value) : null);
        }}>
          <option value="">Organisation defaults</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      {isLoading ? <p>Loading rules…</p> : isError ? <p role="alert">Rules could not be loaded. Refresh to retry.</p> : rules && <div className="mt-3 space-y-3">
        <div className="grid grid-cols-3 gap-2 text-xs font-medium"><span>Check</span><span>Minimum °C</span><span>Maximum °C</span></div>
        {Object.entries(labels).map(([key, label]) => {
          const ruleKey = key as keyof typeof labels;
          return <div key={key} className="grid grid-cols-3 items-center gap-2">
            <span className="text-sm">{label}{!manager && <small className="block">{temperatureRangeLabel(rules[ruleKey])}</small>}</span>
            {(["min", "max"] as const).map(bound => <Input key={bound} aria-label={`${label} ${bound} °C`} type="number" step="0.1"
              disabled={!manager || saving} value={rules[ruleKey][bound] ?? ""} placeholder="No bound"
              onChange={e => { setDirty(true); setRules({ ...rules, [ruleKey]: { ...rules[ruleKey], [bound]: e.target.value === "" ? null : Number(e.target.value) } }); }} />)}
          </div>;
        })}
        <label className="flex items-center gap-3 text-sm">Maximum cooling duration (minutes)
          <Input className="w-28" type="number" min={1} max={1440} disabled={!manager || saving} value={rules.coolingMinutes}
            onChange={e => { setDirty(true); setRules({ ...rules, coolingMinutes: Number(e.target.value) }); }} />
        </label>
        {(["cooking", "sousVide"] as const).map(kind => {
          const { unit, section } = holdFields[kind];
          const field = kind === "cooking" ? "cookingHoldSeconds" : "sousVideHoldMinutes";
          return <label key={kind} className="flex items-center gap-3 text-sm">{section}: minimum hold at core temperature ({unit})
            <Input className="w-28" type="number" min={1} step="1" placeholder="No hold" disabled={!manager || saving} value={rules[field] ?? ""}
              onChange={e => { setDirty(true); setRules({ ...rules, [field]: optionalInt(e.target.value) }); }} />
          </label>;
        })}
        {(["cooking", "sousVide"] as const).map(kind => <ItemRules key={kind} kind={kind} rules={rules} disabled={!manager || saving}
          onChange={next => { setDirty(true); setRules(next); }} />)}
        {manager && <div className="flex flex-wrap gap-2"><Button disabled={saving || !dirty} onClick={() => void save()}>Save numeric rules</Button>
          {siteId !== null && <Button variant="outline" disabled={saving} onClick={() => void save(true)}>Use organisation defaults</Button>}</div>}
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    </details>
    <p className="text-sm text-muted-foreground">Failed readings remain historical evidence. A manager assigns the corrective action and verifies its evidence with a final signature; this does not change the original reading to a pass.</p>
    <ModuleActionsPanel moduleKey="kitchen" />
  </div>;
}