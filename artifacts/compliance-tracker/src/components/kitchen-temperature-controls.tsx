import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetFoodSafetyConfig, useListSites, parseKitchenTemperatureRules, kitchenTemperatureRulesSchema, temperatureRangeLabel, type KitchenTemperatureRules } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { ModuleActionsPanel } from "./module-actions-panel";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const labels: Record<Exclude<keyof KitchenTemperatureRules, "coolingMinutes">, string> = {
  fridge: "Fridges", freezer: "Freezers", chilledDelivery: "Chilled deliveries",
  frozenDelivery: "Frozen deliveries", cooking: "Cooking", cooling: "Cooling",
  reheating: "Reheating", hotHolding: "Hot holding", sousVide: "Sous vide",
};
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
    if (!inherit && !valid.success) { setError("Supply an ordered numeric range for every section."); return; }
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
      <p className="my-3 text-sm text-muted-foreground">These numeric rules, not the legacy descriptive labels, determine failed readings. Confirm them against your site’s food-safety plan; they do not certify compliance. Limits are inclusive. Cooking holding-time requirements still need a separate site procedure.</p>
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
        {manager && <div className="flex flex-wrap gap-2"><Button disabled={saving || !dirty} onClick={() => void save()}>Save numeric rules</Button>
          {siteId !== null && <Button variant="outline" disabled={saving} onClick={() => void save(true)}>Use organisation defaults</Button>}</div>}
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    </details>
    <p className="text-sm text-muted-foreground">Failed readings remain historical evidence. A manager assigns the corrective action and verifies its evidence with a final signature; this does not change the original reading to a pass.</p>
    <ModuleActionsPanel moduleKey="kitchen" />
  </div>;
}