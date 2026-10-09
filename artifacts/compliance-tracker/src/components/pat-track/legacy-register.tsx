import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, CheckCircle2, Clock, Download, Library, Pencil, Plus, Printer, Settings, Trash2, Zap } from "lucide-react";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { printHtmlDocument } from "@/lib/download";

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const types = ["Class I", "Class II", "Class III", "Extension Lead", "IT Equipment", "Portable Tool", "Cleaning Equipment", "AV Equipment", "Kitchen Appliance", "Other"];
const presets: Record<string, { label: string; items: { name: string; type: string }[] }> = {
  "hotel-suite": { label: "Hotel Suite", items: [["Television","AV Equipment"],["Bedside Lamp (Left)","Class I"],["Bedside Lamp (Right)","Class I"],["Standing Lamp","Class I"],["Mini Fridge","Kitchen Appliance"],["Kettle","Kitchen Appliance"],["Hair Dryer","Class II"],["Iron","Class I"],["Trouser Press","Class I"],["Telephone","IT Equipment"],["Air Conditioning Unit","Class I"],["Shower Radio","AV Equipment"],["Safe (Electric)","Class I"]].map(([name,type]) => ({ name,type })) },
  "hotel-classic": { label: "Classic Hotel Room", items: [["Television","AV Equipment"],["Bedside Lamp","Class I"],["Desk Lamp","Class I"],["Kettle","Kitchen Appliance"],["Hair Dryer","Class II"],["Iron","Class I"],["Telephone","IT Equipment"]].map(([name,type]) => ({ name,type })) },
  office: { label: "Office", items: [["Desktop PC","IT Equipment"],["Monitor","IT Equipment"],["Printer","IT Equipment"],["Desk Lamp","Class I"],["Telephone","IT Equipment"],["Extension Lead","Extension Lead"],["Shredder","Class I"]].map(([name,type]) => ({ name,type })) },
  reception: { label: "Reception", items: [["Desktop PC","IT Equipment"],["Monitor","IT Equipment"],["Printer","IT Equipment"],["Telephone","IT Equipment"],["Card Terminal","IT Equipment"],["Desk Lamp","Class I"]].map(([name,type]) => ({ name,type })) },
  "bar-restaurant": { label: "Bar / Restaurant", items: [["Coffee Machine","Kitchen Appliance"],["Glass Washer","Class I"],["Blender","Kitchen Appliance"],["Ice Machine","Class I"],["Till","IT Equipment"],["Refrigerator","Kitchen Appliance"]].map(([name,type]) => ({ name,type })) },
  kitchen: { label: "Kitchen", items: [["Microwave","Kitchen Appliance"],["Toaster","Kitchen Appliance"],["Kettle","Kitchen Appliance"],["Food Mixer","Kitchen Appliance"],["Blender","Kitchen Appliance"],["Refrigerator","Kitchen Appliance"],["Freezer","Kitchen Appliance"],["Dishwasher","Class I"]].map(([name,type]) => ({ name,type })) },
  "pro-shop": { label: "Pro-Shop", items: [["Desktop PC","IT Equipment"],["Printer","IT Equipment"],["POS Terminal / Cash Register","IT Equipment"],["Card Payment Terminal","IT Equipment"],["Telephone","IT Equipment"],["Golf Trolley Battery Charger","Class I"]].map(([name,type]) => ({ name,type })) },
  greenkeeping: { label: "Greenkeeping Facility", items: [["Battery Charger — Ride-On Mower","Class I"],["Cordless Tool Charger — Drill","Portable Tool"],["Extension Lead","Extension Lead"],["Electric Pressure Washer","Portable Tool"],["Angle Grinder","Portable Tool"],["Workshop Lamp","Class I"]].map(([name,type]) => ({ name,type })) },
  "retail-shop": { label: "Retail Shop", items: [["POS Terminal / Till","IT Equipment"],["Barcode Scanner","IT Equipment"],["Receipt Printer","IT Equipment"],["Card Payment Terminal","IT Equipment"],["Desktop PC","IT Equipment"],["Monitor","IT Equipment"],["Extension Lead","Extension Lead"]].map(([name,type]) => ({ name,type })) },
  "pest-control": { label: "Pest Control Store", items: [["Desktop PC","IT Equipment"],["Printer","IT Equipment"],["Battery Charger","Class I"],["Inspection Lamp","Class I"],["Extension Lead","Extension Lead"],["Vacuum Cleaner","Cleaning Equipment"]].map(([name,type]) => ({ name,type })) },
};

type Appliance = { id: number; site_id: number | null; name: string; appliance_type: string; location: string | null; asset_tag: string | null; description: string | null; active: boolean; last_test_date: string | null; last_result: string | null; next_test_date: string | null; last_tested_by: string | null };
type PATTest = { id: number; appliance_id: number; appliance_name: string; asset_tag: string | null; test_date: string; result: string; next_test_date: string | null; tested_by: string | null; visual_inspection: string | null; earth_continuity_ohms: string | null; insulation_mohms: string | null; operating_current: string | null; notes: string | null; site_name_snapshot: string | null; location_snapshot: string | null; snapshot_source: "recorded" | "legacy_backfill" | "legacy_unavailable" };
type Config = { pat_default_tester: string; pat_retest_months: string; pat_locations: string; pat_show_earth_bond: string; pat_show_insulation: string };
type Status = { totalAppliances: number; untested: number; overdue: number; dueSoon: number; ok: number };
type Site = { id: number; name: string };
type View = "appliances" | "tests";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}/api/pat-track${path}`, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? body?.message ?? `Request failed (${response.status})`);
  }
  return response.json();
}
const today = () => new Date().toISOString().slice(0, 10);
const date = (value?: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB") : "—";
const locations = (config?: Config) => { try { const value = JSON.parse(config?.pat_locations ?? "[]"); return Array.isArray(value) ? value : []; } catch { return []; } };
const nextDate = (value: string, months: number) => { const d = new Date(`${value}T12:00:00`); d.setMonth(d.getMonth() + months); return d.toISOString().slice(0, 10); };

function RecordDialog({ open, close, appliance, sites, config, saved }: { open: boolean; close: () => void; appliance: Appliance | null; sites: Site[]; config?: Config; saved: () => void }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", applianceType: "Other", location: "", assetTag: "", description: "", siteId: "", active: true });
  useEffect(() => { if (open) setForm(appliance ? { name: appliance.name, applianceType: appliance.appliance_type, location: appliance.location ?? "", assetTag: appliance.asset_tag ?? "", description: appliance.description ?? "", siteId: appliance.site_id ? String(appliance.site_id) : "", active: appliance.active } : { name: "", applianceType: "Other", location: "", assetTag: "", description: "", siteId: "", active: true }); }, [open, appliance]);
  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await api(appliance ? `/appliances/${appliance.id}` : "/appliances", { method: appliance ? "PUT" : "POST", body: JSON.stringify({ name: form.name.trim(), applianceType: form.applianceType, location: form.location.trim() || null, assetTag: form.assetTag.trim() || null, description: form.description.trim() || null, siteId: form.siteId ? Number(form.siteId) : null, active: form.active }) });
      toast({ title: appliance ? "Appliance updated" : "Appliance added" }); saved(); close();
    } catch (e) { toast({ title: "Unable to save appliance", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" }); } finally { setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={v => !v && close()}><DialogContent className="max-w-md max-h-[90vh] overflow-y-auto rounded-sm"><DialogHeader><DialogTitle>{appliance ? "Edit appliance" : "Add appliance"}</DialogTitle></DialogHeader><div className="space-y-4">
    <Field testId="input-legacy-appliance-name" label="Appliance name *" value={form.name} set={name => setForm({ ...form, name })} />
    <div className="grid grid-cols-2 gap-3"><div><Label>Appliance type</Label><select data-testid="select-legacy-appliance-type" className="mt-1 h-10 w-full rounded-sm border bg-background px-3 text-sm" value={form.applianceType} onChange={e => setForm({ ...form, applianceType: e.target.value })}>{types.map(x => <option key={x}>{x}</option>)}</select></div><Field label="Asset tag" value={form.assetTag} set={assetTag => setForm({ ...form, assetTag })} /></div>
    <div><datalist id="legacy-pat-locations">{locations(config).map((x: string) => <option key={x} value={x}/>)}</datalist><Label>Location / area</Label><Input data-testid="input-legacy-appliance-location" list="legacy-pat-locations" className="mt-1" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })}/></div>
    <Field label="Description / serial number" value={form.description} set={description => setForm({ ...form, description })} />
    <div><Label>Site</Label><select data-testid="select-legacy-appliance-site" className="mt-1 h-10 w-full rounded-sm border bg-background px-3 text-sm" value={form.siteId} onChange={e => setForm({ ...form, siteId: e.target.value })}><option value="">All sites</option>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
    {appliance && <label className="flex items-center justify-between rounded-sm border p-3 text-sm"><span>Active appliance</span><Switch data-testid="switch-legacy-appliance-active" checked={form.active} onCheckedChange={active => setForm({ ...form, active })}/></label>}
  </div><DialogFooter><Button data-testid="button-cancel-legacy-appliance" variant="outline" onClick={close}>Cancel</Button><Button data-testid="button-save-legacy-appliance" disabled={!form.name.trim() || saving} onClick={save}>{saving ? "Saving…" : "Save appliance"}</Button></DialogFooter></DialogContent></Dialog>;
}

function TestDialog({ open, close, test, appliances, config, presetId, saved }: { open: boolean; close: () => void; test: PATTest | null; appliances: Appliance[]; config?: Config; presetId?: number; saved: () => void }) {
  const { user } = useAuth(); const { toast } = useToast(); const [saving, setSaving] = useState(false);
  const blank = () => ({ applianceId: presetId ? String(presetId) : "", testDate: today(), result: "pass", nextTestDate: nextDate(today(), Number(config?.pat_retest_months) || 12), testedBy: config?.pat_default_tester || user?.name || "", visualInspection: "pass", earthContinuityOhms: "", insulationMohms: "", operatingCurrent: "", notes: "" });
  const [form, setForm] = useState(blank);
  useEffect(() => { if (open) setForm(test ? { applianceId: String(test.appliance_id), testDate: test.test_date, result: test.result, nextTestDate: test.next_test_date ?? "", testedBy: test.tested_by ?? "", visualInspection: test.visual_inspection ?? "pass", earthContinuityOhms: test.earth_continuity_ohms ?? "", insulationMohms: test.insulation_mohms ?? "", operatingCurrent: test.operating_current ?? "", notes: test.notes ?? "" } : blank()); }, [open, test, presetId, config]);
  const save = async () => {
    if (!form.applianceId || !form.testDate) return;
    setSaving(true);
    try {
      await api(test ? `/tests/${test.id}` : "/tests", { method: test ? "PUT" : "POST", body: JSON.stringify({ applianceId: Number(form.applianceId), testDate: form.testDate, result: form.result, nextTestDate: form.nextTestDate || null, testedBy: form.testedBy.trim() || null, visualInspection: form.visualInspection, earthContinuityOhms: form.earthContinuityOhms.trim() || null, insulationMohms: form.insulationMohms.trim() || null, operatingCurrent: form.operatingCurrent.trim() || null, notes: form.notes.trim() || null }) });
      toast({ title: test ? "Test record updated" : "Test recorded" }); saved(); close();
    } catch (e) { toast({ title: "Unable to save test", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" }); } finally { setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={v => !v && close()}><DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto rounded-sm"><DialogHeader><DialogTitle>{test ? "Edit PAT test" : "Log PAT test"}</DialogTitle></DialogHeader><div className="space-y-4">
    <div><Label>Appliance *</Label><select data-testid="select-legacy-test-appliance" disabled={!!test} className="mt-1 h-10 w-full rounded-sm border bg-background px-3 text-sm" value={form.applianceId} onChange={e => setForm({ ...form, applianceId: e.target.value })}><option value="">Select appliance</option>{appliances.filter(a => a.active || a.id === test?.appliance_id).map(a => <option key={a.id} value={a.id}>{a.name}{a.asset_tag ? ` (${a.asset_tag})` : ""}{!a.active ? " (Retired)" : ""}</option>)}</select>{test && <p className="mt-1 text-xs text-muted-foreground">This retained test record cannot be reassigned to another appliance.</p>}</div>
    <div className="grid grid-cols-2 gap-3"><Field label="Test date *" type="date" value={form.testDate} set={testDate => setForm({ ...form, testDate, nextTestDate: test ? form.nextTestDate : nextDate(testDate, Number(config?.pat_retest_months) || 12) })}/><div><Label>Overall result *</Label><select data-testid="select-legacy-test-result" className="mt-1 h-10 w-full rounded-sm border bg-background px-3 text-sm" value={form.result} onChange={e => setForm({ ...form, result: e.target.value })}><option value="pass">Pass</option><option value="fail">Fail</option></select></div></div>
    <div className="grid grid-cols-2 gap-3"><Field label="Tested by" value={form.testedBy} set={testedBy => setForm({ ...form, testedBy })}/><Field label="Next test due" type="date" value={form.nextTestDate} set={nextTestDate => setForm({ ...form, nextTestDate })}/></div>
    <div><Label>Visual inspection</Label><select data-testid="select-legacy-visual-inspection" className="mt-1 h-10 w-full rounded-sm border bg-background px-3 text-sm" value={form.visualInspection} onChange={e => setForm({ ...form, visualInspection: e.target.value })}><option value="pass">Pass</option><option value="fail">Fail</option><option value="na">N/A</option></select></div>
    {(config?.pat_show_earth_bond !== "false" || config?.pat_show_insulation !== "false") && <div className="grid grid-cols-2 gap-3 rounded-sm border bg-muted/20 p-3">{config?.pat_show_earth_bond !== "false" && <Field label="Earth continuity (Ω)" value={form.earthContinuityOhms} set={earthContinuityOhms => setForm({ ...form, earthContinuityOhms })}/>} {config?.pat_show_insulation !== "false" && <Field label="Insulation resistance (MΩ)" value={form.insulationMohms} set={insulationMohms => setForm({ ...form, insulationMohms })}/>}<Field label="Operating current (A)" value={form.operatingCurrent} set={operatingCurrent => setForm({ ...form, operatingCurrent })}/></div>}
    <div><Label>Notes</Label><Textarea data-testid="textarea-legacy-test-notes" className="mt-1" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}/></div>
  </div><DialogFooter><Button data-testid="button-cancel-legacy-test" variant="outline" onClick={close}>Cancel</Button><Button data-testid="button-save-legacy-test" disabled={!form.applianceId || !form.testDate || saving} onClick={save}>{saving ? "Saving…" : "Save test"}</Button></DialogFooter></DialogContent></Dialog>;
}

function ConfigDialog({ config, saved }: { config?: Config; saved: () => void }) {
  const [open, setOpen] = useState(false); const [saving, setSaving] = useState(false); const { toast } = useToast();
  const [form, setForm] = useState({ tester: "", months: "12", locations: "", earth: true, insulation: true });
  useEffect(() => { if (open && config) setForm({ tester: config.pat_default_tester, months: config.pat_retest_months, locations: locations(config).join(", "), earth: config.pat_show_earth_bond !== "false", insulation: config.pat_show_insulation !== "false" }); }, [open, config]);
  const save = async () => { setSaving(true); try { await api("/config", { method: "PUT", body: JSON.stringify({ pat_default_tester: form.tester, pat_retest_months: form.months, pat_locations: JSON.stringify(form.locations.split(",").map(x => x.trim()).filter(Boolean)), pat_show_earth_bond: String(form.earth), pat_show_insulation: String(form.insulation) }) }); toast({ title: "PAT settings saved" }); saved(); setOpen(false); } catch (e) { toast({ title: "Unable to save settings", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" }); } finally { setSaving(false); } };
  return <><Button data-testid="button-open-legacy-pat-settings" variant="outline" size="sm" onClick={() => setOpen(true)}><Settings className="mr-1 h-4 w-4"/>Settings</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-md rounded-sm"><DialogHeader><DialogTitle>Legacy PAT settings</DialogTitle></DialogHeader><div className="space-y-4"><Field label="Default tester" value={form.tester} set={tester => setForm({ ...form, tester })}/><div><Label>Default retest interval</Label><select data-testid="select-legacy-retest-months" className="mt-1 h-10 w-full rounded-sm border bg-background px-3 text-sm" value={form.months} onChange={e => setForm({ ...form, months: e.target.value })}>{[3,6,12,24,48].map(x => <option key={x} value={x}>{x} months</option>)}</select></div><Field label="Suggested locations (comma separated)" value={form.locations} set={value => setForm({ ...form, locations: value })}/><label className="flex justify-between text-sm">Show earth continuity field<Switch data-testid="switch-legacy-earth" checked={form.earth} onCheckedChange={earth => setForm({ ...form, earth })}/></label><label className="flex justify-between text-sm">Show insulation field<Switch data-testid="switch-legacy-insulation" checked={form.insulation} onCheckedChange={insulation => setForm({ ...form, insulation })}/></label></div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button data-testid="button-save-legacy-pat-settings" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save settings"}</Button></DialogFooter></DialogContent></Dialog></>;
}

function PresetDialog({ open, close, sites, config, saved }: { open: boolean; close: () => void; sites: Site[]; config?: Config; saved: () => void }) {
  const { toast } = useToast(); const qc = useQueryClient(); const [key, setKey] = useState(""); const [items, setItems] = useState<{ name: string; type: string; checked: boolean }[]>([]); const [location, setLocation] = useState(""); const [siteId, setSiteId] = useState(""); const [saving, setSaving] = useState(false);
  const templatesQ = useQuery({ queryKey: ["pat-track", "legacy-presets"], queryFn: () => api<Record<string, { name: string; type: string }[]>>("/preset-templates"), enabled: open });
  useEffect(() => { if (!open) { setKey(""); setItems([]); setLocation(""); setSiteId(""); } }, [open]);
  const choose = (value: string) => { setKey(value); setItems((templatesQ.data?.[value] ?? presets[value].items).map(x => ({ ...x, checked: true }))); };
  const saveTemplate = async () => { await api(`/preset-templates/${key}`, { method: "PUT", body: JSON.stringify({ items: items.map(({ name, type }) => ({ name, type })) }) }); qc.invalidateQueries({ queryKey: ["pat-track", "legacy-presets"] }); toast({ title: "Preset template saved" }); };
  const reset = async () => { await api(`/preset-templates/${key}`, { method: "DELETE" }); setItems(presets[key].items.map(x => ({ ...x, checked: true }))); qc.invalidateQueries({ queryKey: ["pat-track", "legacy-presets"] }); toast({ title: "Preset reset to defaults" }); };
  const add = async () => { setSaving(true); try { const selected = items.filter(x => x.checked && x.name.trim()); await Promise.all(selected.map(x => api("/appliances", { method: "POST", body: JSON.stringify({ name: x.name.trim(), applianceType: x.type, location: location.trim() || null, siteId: siteId ? Number(siteId) : null, active: true }) }))); toast({ title: `${selected.length} appliances added` }); saved(); close(); } catch (e) { toast({ title: "Unable to load preset", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" }); } finally { setSaving(false); } };
  return <Dialog open={open} onOpenChange={v => !v && close()}><DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto rounded-sm"><DialogHeader><DialogTitle>Load appliance preset</DialogTitle></DialogHeader>{!key ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{Object.entries(presets).map(([id,p]) => <button data-testid={`button-legacy-preset-${id}`} key={id} className="rounded-sm border p-4 text-left hover:border-primary" onClick={() => choose(id)}><b className="text-sm">{p.label}</b><p className="text-xs text-muted-foreground">{(templatesQ.data?.[id] ?? p.items).length} appliances{templatesQ.data?.[id] ? " · customised" : ""}</p></button>)}</div> : <div className="space-y-4"><div className="flex items-center justify-between"><Button variant="ghost" size="sm" onClick={() => setKey("")}>← Choose another preset</Button><div className="flex gap-2"><Button data-testid="button-save-legacy-preset-template" variant="outline" size="sm" onClick={saveTemplate}>Save template</Button>{templatesQ.data?.[key] && <Button data-testid="button-reset-legacy-preset-template" variant="ghost" size="sm" onClick={reset}>Reset defaults</Button>}</div></div><div className="grid grid-cols-2 gap-3"><div><Label>Location</Label><Input data-testid="input-legacy-preset-location" list="legacy-pat-locations" value={location} onChange={e => setLocation(e.target.value)}/></div><div><Label>Site</Label><select data-testid="select-legacy-preset-site" className="h-10 w-full rounded-sm border bg-background px-3 text-sm" value={siteId} onChange={e => setSiteId(e.target.value)}><option value="">All sites</option>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div></div><div className="max-h-72 space-y-1 overflow-y-auto rounded-sm border p-2">{items.map((item,i) => <div key={i} className="grid grid-cols-[auto_1fr_10rem_auto] items-center gap-2"><input data-testid={`checkbox-legacy-preset-item-${i}`} type="checkbox" checked={item.checked} onChange={e => setItems(v => v.map((x,n) => n === i ? { ...x, checked: e.target.checked } : x))}/><Input value={item.name} onChange={e => setItems(v => v.map((x,n) => n === i ? { ...x, name: e.target.value } : x))}/><select className="h-9 rounded-sm border bg-background text-xs" value={item.type} onChange={e => setItems(v => v.map((x,n) => n === i ? { ...x, type: e.target.value } : x))}>{types.map(x => <option key={x}>{x}</option>)}</select><Button variant="ghost" size="icon" onClick={() => setItems(v => v.filter((_,n) => n !== i))}><Trash2 className="h-3 w-3"/></Button></div>)}</div><Button data-testid="button-add-legacy-preset-item" variant="outline" size="sm" onClick={() => setItems(v => [...v, { name: "", type: "Other", checked: true }])}><Plus className="mr-1 h-3 w-3"/>Add item</Button></div>}<DialogFooter><Button variant="outline" onClick={close}>Cancel</Button>{key && <Button data-testid="button-load-legacy-preset" disabled={saving || !items.some(x => x.checked && x.name.trim())} onClick={add}>{saving ? "Adding…" : "Add selected appliances"}</Button>}</DialogFooter></DialogContent></Dialog>;
}

function Field({ label, value, set, type = "text", testId }: { label: string; value: string; set: (value: string) => void; type?: string; testId?: string }) {
  return <div><Label>{label}</Label><Input data-testid={testId} className="mt-1" type={type} value={value} onChange={e => set(e.target.value)}/></div>;
}

export function LegacyPATRegister({ view }: { view: View }) {
  const { user } = useAuth(); const canAdmin = useCanAdmin(); const { toast } = useToast(); const qc = useQueryClient(); const locked = user?.role === "client_viewer";
  const [search, setSearch] = useState(""); const [registerSiteId, setRegisterSiteId] = useState(""); const [registerStatus, setRegisterStatus] = useState<"all" | "overdue">("all"); const [downloading, setDownloading] = useState(false); const [recordOpen, setRecordOpen] = useState(false); const [testOpen, setTestOpen] = useState(false); const [presetOpen, setPresetOpen] = useState(false); const [editAppliance, setEditAppliance] = useState<Appliance | null>(null); const [editTest, setEditTest] = useState<PATTest | null>(null); const [presetId, setPresetId] = useState<number>(); const [retiring, setRetiring] = useState<number | null>(null);
  const appliancesQ = useQuery({ queryKey: ["pat-track","legacy-appliances"], queryFn: () => api<Appliance[]>("/appliances") });
  const testsQ = useQuery({ queryKey: ["pat-track","legacy-tests"], queryFn: () => api<PATTest[]>("/tests") });
  const statusQ = useQuery({ queryKey: ["pat-track","legacy-status"], queryFn: () => api<Status>("/status") });
  const configQ = useQuery({ queryKey: ["pat-track","legacy-config"], queryFn: () => api<Config>("/config"), enabled: canAdmin });
  const sitesQ = useQuery({ queryKey: ["pat-track","legacy-sites"], queryFn: async () => { const r = await fetch(`${baseUrl}/api/sites`, { credentials: "include" }); if (!r.ok) throw new Error("Unable to load sites"); return r.json() as Promise<Site[]>; } });
  const refresh = () => { ["legacy-appliances","legacy-tests","legacy-status"].forEach(x => qc.invalidateQueries({ queryKey: ["pat-track",x] })); };
  const appliances = appliancesQ.data ?? [], tests = testsQ.data ?? [], q = search.toLowerCase();
  const shownAppliances = useMemo(() => appliances.filter(a => [a.name,a.appliance_type,a.location,a.asset_tag].some(x => x?.toLowerCase().includes(q))), [appliances,q]);
  const shownTests = useMemo(() => tests.filter(t => [t.appliance_name,t.tested_by,t.asset_tag,t.site_name_snapshot,t.location_snapshot].some(x => x?.toLowerCase().includes(q))), [tests,q]);
  const retireAppliance = async () => { if (retiring === null) return; try { await api(`/appliances/${retiring}`, { method: "DELETE" }); toast({ title: "Appliance retired", description: "The appliance and its PAT test history are retained in the archive." }); refresh(); setRetiring(null); } catch (e) { toast({ title: "Unable to retire appliance", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" }); } };
  const status = statusQ.data;
  const exportRegister = () => {
    const esc = (value?: string | null) => (value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const rows = [...shownAppliances].sort((a, b) => a.name.localeCompare(b.name));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>PAT Test Register</title>
<style>
body { font-family: Georgia, serif; color: #1a1a1a; margin: 32px; }
h1 { font-size: 20px; margin: 0 0 2px; }
.meta { font-size: 11px; color: #555; margin-bottom: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-top: 10px; }
th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #f0ede2; font-weight: bold; }
.empty { font-size: 11px; color: #777; font-style: italic; }
.fail, .overdue { color: #b91c1c; font-weight: bold; }
@media print { body { margin: 12mm; } }
</style></head><body>
<h1>Portable Appliance Test (PAT) Register</h1>
<div class="meta">Generated ${date(new Date().toISOString())} — for insurance / electrical safety audits</div>
<div class="meta">${rows.length} appliance${rows.length !== 1 ? "s" : ""}${status ? ` · ${status.overdue} overdue · ${status.untested} not yet tested` : ""}</div>
${rows.length === 0 ? `<p class="empty">No appliances match the current filters.</p>` : `<table>
<tr><th>Appliance</th><th>Type</th><th>Location / room</th><th>Asset tag</th><th>Last test date</th><th>Result</th><th>Tested by</th><th>Next test due</th></tr>
${rows.map(a => {
  const overdue = !!a.next_test_date && a.next_test_date < today();
  const result = a.last_result === "pass" ? "Pass" : a.last_result === "fail" ? "Fail" : a.last_result ? esc(a.last_result) : "Not tested";
  return `<tr>
<td>${esc(a.name)}</td><td>${esc(a.appliance_type)}</td><td>${esc(a.location) || "—"}</td><td>${esc(a.asset_tag) || "—"}</td>
<td>${date(a.last_test_date)}</td><td><span class="${a.last_result === "fail" ? "fail" : ""}">${result}</span></td>
<td>${esc(a.last_tested_by) || "—"}</td><td><span class="${overdue ? "overdue" : ""}">${date(a.next_test_date)}${overdue ? " (overdue)" : ""}</span></td>
</tr>`;
}).join("")}</table>`}
</body></html>`;
    printHtmlDocument(html);
  };
  const downloadRegister = async () => {
    setDownloading(true);
    try {
      const params = new URLSearchParams({ status: registerStatus });
      if (registerSiteId) params.set("siteId", registerSiteId);
      const response = await fetch(`${baseUrl}/api/pat-track/register?${params}`, { credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "pat-test-register.csv";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: "Unable to download register", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };
  return <div className="space-y-5" data-testid={`panel-legacy-${view}`}>
    {status && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[[status.totalAppliances,"Total appliances",Zap],[status.overdue,"Overdue",AlertTriangle],[status.dueSoon,"Due soon",Clock],[status.ok,"Up to date",CheckCircle2]].map(([n,label,Icon]) => { const I = Icon as typeof Zap; return <Card key={label as string} className="rounded-sm"><CardContent className="flex items-center gap-3 p-4"><I className="h-5 w-5 text-primary"/><div><b className="text-xl">{n as number}</b><p className="text-xs text-muted-foreground">{label as string}</p></div></CardContent></Card>; })}</div>}
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="font-semibold">{view === "appliances" ? "Legacy appliance register" : "Legacy appliance test history"}</h2><p className="text-sm text-muted-foreground">Retired appliances and past tests remain available for evidence; only active appliances can receive new tests.</p></div><div className="flex flex-wrap gap-2">{canAdmin && <><select aria-label="Register site" data-testid="select-legacy-pat-register-site" className="h-9 rounded-sm border bg-background px-2 text-sm" value={registerSiteId} onChange={e => setRegisterSiteId(e.target.value)}><option value="">All sites</option>{(sitesQ.data ?? []).map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select><select aria-label="Register status" data-testid="select-legacy-pat-register-status" className="h-9 rounded-sm border bg-background px-2 text-sm" value={registerStatus} onChange={e => setRegisterStatus(e.target.value as "all" | "overdue")}><option value="all">All statuses</option><option value="overdue">Overdue only</option></select><Button data-testid="button-download-pat-register" variant="outline" size="sm" disabled={downloading} onClick={downloadRegister}><Download className="mr-1 h-4 w-4"/>{downloading ? "Downloading…" : "Download register"}</Button></>}<Button data-testid="button-export-legacy-pat-register" variant="outline" size="sm" onClick={exportRegister} title="Print or save the PAT test register for insurance / electrical safety audits"><Printer className="mr-1 h-4 w-4"/>Print register</Button>{canAdmin && <ConfigDialog config={configQ.data} saved={() => qc.invalidateQueries({ queryKey: ["pat-track","legacy-config"] })}/>} {view === "appliances" && canAdmin && !locked && <><Button data-testid="button-open-legacy-preset" variant="outline" size="sm" onClick={() => setPresetOpen(true)}><Library className="mr-1 h-4 w-4"/>Load preset</Button><Button data-testid="button-add-legacy-appliance" size="sm" onClick={() => { setEditAppliance(null); setRecordOpen(true); }}><Plus className="mr-1 h-4 w-4"/>Add appliance</Button></>} {!locked && <Button data-testid="button-add-legacy-test" size="sm" onClick={() => { setEditTest(null); setPresetId(undefined); setTestOpen(true); }}><Plus className="mr-1 h-4 w-4"/>Log test</Button>}</div></div>
    <Input data-testid="input-search-legacy-pat" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search appliances, locations, asset tags or testers…"/>
    {(appliancesQ.isLoading || testsQ.isLoading) ? <p className="py-8 text-center text-sm text-muted-foreground">Loading legacy register…</p> : view === "appliances" ? <div className="overflow-x-auto rounded-sm border"><table className="w-full text-sm"><thead className="bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="p-3">Appliance</th><th className="p-3">Type</th><th className="p-3">Location</th><th className="p-3">Last tested</th><th className="p-3">Next due</th><th className="p-3">Status</th><th className="p-3"/></tr></thead><tbody>{shownAppliances.map(a => { const state = !a.next_test_date ? "Not tested" : a.next_test_date < today() ? "Overdue" : a.next_test_date <= nextDate(today(),1) ? "Due soon" : "Up to date"; return <tr data-testid={`row-legacy-appliance-${a.id}`} key={a.id} className="border-t"><td className="p-3 font-medium">{a.name}<small className="block text-muted-foreground">{a.asset_tag}</small></td><td className="p-3">{a.appliance_type}</td><td className="p-3">{a.location || "—"}</td><td className="p-3">{date(a.last_test_date)}</td><td className="p-3">{date(a.next_test_date)}</td><td className="p-3"><div className="flex flex-wrap gap-1"><Badge variant="outline">{state}</Badge>{!a.active && <Badge variant="outline">Retired</Badge>}</div></td><td className="p-3"><div className="flex gap-1">{a.active && !locked && <Button data-testid={`button-test-legacy-appliance-${a.id}`} variant="ghost" size="icon" onClick={() => { setEditTest(null); setPresetId(a.id); setTestOpen(true); }}><Zap className="h-4 w-4"/></Button>}{canAdmin && <><Button data-testid={`button-edit-legacy-appliance-${a.id}`} variant="ghost" size="icon" onClick={() => { setEditAppliance(a); setRecordOpen(true); }}><Pencil className="h-4 w-4"/></Button><Button data-testid={`button-retire-legacy-appliance-${a.id}`} aria-label={`Retire ${a.name}`} title="Retire appliance and retain its test history" variant="ghost" size="icon" disabled={!a.active} onClick={() => setRetiring(a.id)}><Archive className="h-4 w-4"/></Button></>}</div></td></tr>; })}</tbody></table>{!shownAppliances.length && <p className="p-8 text-center text-sm text-muted-foreground">No appliances match this search.</p>}</div> : <div className="overflow-x-auto rounded-sm border"><table className="w-full text-sm"><thead className="bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="p-3">Appliance</th><th className="p-3">Test date</th><th className="p-3">Historic site / location</th><th className="p-3">Result</th><th className="p-3">Tested by</th><th className="p-3">Next due</th><th className="p-3">Photos</th><th className="p-3"/></tr></thead><tbody>{shownTests.map(t => { const snapshotLocation = [t.site_name_snapshot, t.location_snapshot].filter(Boolean).join(" · "); const historyLocation = t.snapshot_source === "recorded" ? `Recorded at test: ${snapshotLocation || "No location recorded"}` : t.snapshot_source === "legacy_backfill" ? `Legacy backfill (not verified at test date): ${snapshotLocation || "Historic location unavailable"}` : "Historic site / location unavailable"; return <tr data-testid={`row-legacy-test-${t.id}`} key={t.id} className="border-t"><td className="p-3 font-medium">{t.appliance_name}{t.asset_tag && <small className="block text-muted-foreground">{t.asset_tag}</small>}</td><td className="p-3">{date(t.test_date)}</td><td className="p-3 text-sm">{historyLocation}</td><td className="p-3"><Badge className={t.result === "pass" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}>{t.result}</Badge></td><td className="p-3">{t.tested_by || "—"}</td><td className="p-3">{date(t.next_test_date)}</td><td className="p-3"><CheckPhotoUploader entityType="pat_test" entityId={t.id} compact readOnly={locked} /></td><td className="p-3">{!locked && <Button data-testid={`button-edit-legacy-test-${t.id}`} variant="ghost" size="icon" onClick={() => { setEditTest(t); setTestOpen(true); }}><Pencil className="h-4 w-4"/></Button>}</td></tr>; })}</tbody></table>{!shownTests.length && <p className="p-8 text-center text-sm text-muted-foreground">No appliance tests match this search.</p>}</div>}
    <RecordDialog open={recordOpen} close={() => setRecordOpen(false)} appliance={editAppliance} sites={sitesQ.data ?? []} config={configQ.data} saved={refresh}/>
    <TestDialog open={testOpen} close={() => { setTestOpen(false); setPresetId(undefined); }} test={editTest} appliances={appliances} config={configQ.data} presetId={presetId} saved={refresh}/>
    <PresetDialog open={presetOpen} close={() => setPresetOpen(false)} sites={sitesQ.data ?? []} config={configQ.data} saved={refresh}/>
    <AlertDialog open={retiring !== null} onOpenChange={v => !v && setRetiring(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Retire this appliance?</AlertDialogTitle><AlertDialogDescription>This removes the appliance from active test targets. Existing PAT tests and snapshot evidence remain available in history, and an administrator can reactivate the appliance from Edit appliance.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction data-testid="button-confirm-retire-legacy-appliance" onClick={retireAppliance}>Retire appliance</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}