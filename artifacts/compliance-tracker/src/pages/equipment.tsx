import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useListComplianceItems, useListSites,
  type EquipmentItem, type EquipmentLabelTarget, type EquipmentType,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { useWorkingSiteId } from "@/hooks/use-working-site";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { downloadBlob } from "@/lib/download";
import { Archive, ChevronDown, ChevronUp, Download, Flame, Loader2, Pencil, Plus, QrCode, RefreshCw, RotateCcw, Search } from "lucide-react";
import { sortByLabel } from "@/lib/sort-options";

const TYPE_LABELS: Record<EquipmentType, string> = {
  cold_water_tank: "Cold water storage tank",
  calorifier: "Calorifier",
  boiler: "Boiler",
  water_heater: "Water heater",
  lift: "Lift",
  hoist: "Hoist",
  lifting_equipment: "Lifting equipment",
  pressure_system: "Pressure system",
  gas_appliance: "Gas appliance",
  air_conditioning: "Air conditioning",
  fire_extinguisher: "Fire extinguisher",
  ladder: "Ladder or step",
  other: "Other equipment",
};

const TYPE_HINTS: Partial<Record<EquipmentType, string>> = {
  cold_water_tank: "Scanning the label opens its temperature, inspection and clean records in LegionellaTrack.",
  calorifier: "Scanning the label opens its temperature, inspection and clean records in LegionellaTrack.",
  boiler: "Link its gas safety and service Compliance Checks below so a scan shows whether they are in date.",
  lift: "Link its LOLER thorough examination Compliance Check below so a scan shows whether it is in date.",
  hoist: "Link its LOLER thorough examination Compliance Check below so a scan shows whether it is in date.",
  lifting_equipment: "Link its LOLER thorough examination Compliance Check below so a scan shows whether it is in date.",
  pressure_system: "Link its written scheme examination Compliance Check below so a scan shows whether it is in date.",
  gas_appliance: "Link its gas safety Compliance Check below so a scan shows whether it is in date.",
  fire_extinguisher: "Scanning the label shows the last extinguisher check for its location in FireTrack.",
};

const ALL = "all";
const NO_SITE = "none";

type SiteOption = { id: number; name: string };

function siteParam(site: string): string {
  return site === ALL ? "" : `?siteId=${encodeURIComponent(site)}`;
}

async function readJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, fallback));
  return await res.json() as T;
}

function SetupGuide() {
  const [open, setOpen] = useState(() => {
    try { return window.localStorage.getItem("complytrack-qr-guide-hidden") !== "1"; } catch { return true; }
  });
  const toggle = () => {
    setOpen(value => {
      try { window.localStorage.setItem("complytrack-qr-guide-hidden", value ? "1" : "0"); } catch { /* remembered for this visit only */ }
      return !value;
    });
  };
  return (
    <Card className="p-4">
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2 font-semibold"><QrCode className="h-5 w-5 text-primary" /> How to set up QR labels</span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li><span className="font-medium text-foreground">Check your items are listed.</span> Mowers, fridges, outlets, call points, hot tubs, bikes, rooms and PAT items come from their tracks automatically. Add anything else (boilers, water tanks, calorifiers, lifts, extinguishers) on the Equipment list tab.</li>
          <li><span className="font-medium text-foreground">Add labels for each track's checks.</span> Every track you have gets labels for each site too: opening and closing checks, kitchen records, greenkeeping daily checks, the fire log, water and pool tests, COSHH register, report a fault, report an accident and the rest. Stick them where the work happens, such as the opening checks by the staff entrance or the COSHH register on the chemical store door.</li>
          <li><span className="font-medium text-foreground">Link the checks that keep it in date.</span> Edit a boiler or lift and tick its gas safety, service or LOLER Compliance Checks.</li>
          <li><span className="font-medium text-foreground">Print a label sheet.</span> On the Print labels tab, pick a site, tick the items and download the PDF. Print it at 100% (actual size) on A4 label sheets: 21 per sheet for indoor items, or 8 larger weatherproof labels per sheet for machines and plant rooms.</li>
          <li><span className="font-medium text-foreground">Stick each label on its item</span> where it is easy to scan and out of heat and water spray. Scan one with your phone camera to check it opens the right item.</li>
          <li><span className="font-medium text-foreground">Tell your team.</span> Staff scan the label with their phone camera, sign in if asked, see whether the item is in date and tap the button for today's check, reading or fault report.</li>
          <li><span className="font-medium text-foreground">Lost or damaged label?</span> On the Print labels tab, use Reprint for the same code, or Replace to stop the old label working and print a new one.</li>
        </ol>
      )}
    </Card>
  );
}

function ItemDialog({ item, sites, defaultSite, open, onOpenChange, onSaved }: {
  item: EquipmentItem | null;
  sites: SiteOption[];
  defaultSite: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  // A new item starts on the page's site filter, else the user's working site.
  const workingSiteId = useWorkingSiteId();
  const newSite = defaultSite !== ALL ? defaultSite : workingSiteId ? String(workingSiteId) : NO_SITE;
  const [form, setForm] = useState(() => ({
    name: item?.name ?? "",
    type: (item?.type ?? "other") as EquipmentType,
    siteId: item ? (item.siteId ? String(item.siteId) : NO_SITE) : newSite,
    location: item?.location ?? "",
    make: item?.make ?? "",
    model: item?.model ?? "",
    serialNo: item?.serialNo ?? "",
    notes: item?.notes ?? "",
    checkIds: new Set((item?.complianceItems ?? []).map(check => check.id)),
  }));
  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(current => ({ ...current, [key]: value }));
  const { data: checks = [] } = useListComplianceItems(undefined, { query: { enabled: open } as never });
  // Checks at the item's site, or for the whole business.
  const siteChecks = checks
    .filter(check => form.checkIds.has(check.id) || !check.siteId || String(check.siteId) === form.siteId)
    .sort((a, b) => a.title.localeCompare(b.title));
  const [checkSearch, setCheckSearch] = useState("");
  const shownChecks = siteChecks.filter(check => !checkSearch.trim() || form.checkIds.has(check.id)
    || check.title.toLowerCase().includes(checkSearch.trim().toLowerCase()));

  const toggleCheck = (id: number, on: boolean) => {
    const next = new Set(form.checkIds);
    if (on) next.add(id); else next.delete(id);
    update("checkIds", next);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast({ title: "Give the item a name", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        siteId: form.siteId === NO_SITE ? null : Number(form.siteId),
        location: form.location.trim() || null,
        make: form.make.trim() || null,
        model: form.model.trim() || null,
        serialNo: form.serialNo.trim() || null,
        notes: form.notes.trim() || null,
        complianceItemIds: [...form.checkIds],
      };
      const res = await apiFetch(item ? `/equipment/${item.id}` : "/equipment", {
        method: item ? "PUT" : "POST", body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Unable to save the item"));
      toast({ title: item ? "Equipment updated" : "Equipment added" });
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast({ title: "Couldn't save the item", description: (error as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const hint = TYPE_HINTS[form.type];

  return (
    <Dialog open={open} onOpenChange={value => !saving && onOpenChange(value)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto rounded-sm">
        <DialogHeader>
          <DialogTitle>{item ? "Edit equipment" : "Add equipment"}</DialogTitle>
          <DialogDescription>Items here can carry a QR label. Items kept in a track (mowers, fridges, outlets) are labelled from the Print labels tab.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="equipment-name">Name</Label>
            <Input id="equipment-name" value={form.name} onChange={e => update("name", e.target.value)} placeholder="e.g. Boiler 1, Main cold water tank" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={form.type} onValueChange={value => update("type", value as EquipmentType)}>
              <SelectTrigger aria-label="Equipment type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {sortByLabel(Object.keys(TYPE_LABELS) as EquipmentType[], type => TYPE_LABELS[type]).map(type => <SelectItem key={type} value={type}>{TYPE_LABELS[type]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Site</Label>
            <Select value={form.siteId} onValueChange={value => update("siteId", value)}>
              <SelectTrigger aria-label="Equipment site"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SITE}>No particular site</SelectItem>
                {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {hint && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground sm:col-span-2">{hint}</p>}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="equipment-location">Location</Label>
            <Input id="equipment-location" value={form.location} onChange={e => update("location", e.target.value)} placeholder="e.g. Plant room, roof void, kitchen corridor" />
          </div>
          <div className="space-y-1.5"><Label htmlFor="equipment-make">Make</Label><Input id="equipment-make" value={form.make} onChange={e => update("make", e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="equipment-model">Model</Label><Input id="equipment-model" value={form.model} onChange={e => update("model", e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="equipment-serial">Serial number</Label><Input id="equipment-serial" value={form.serialNo} onChange={e => update("serialNo", e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Compliance Checks for this item</Label>
            <p className="text-xs text-muted-foreground">Tick the checks (gas safety, LOLER, service) that keep it in date. A scan shows each one's due date.</p>
            {siteChecks.length > 6 && (
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input value={checkSearch} onChange={e => setCheckSearch(e.target.value)} placeholder="Find a check" className="pl-8" aria-label="Find a Compliance Check" />
              </div>
            )}
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {shownChecks.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No Compliance Checks at this site yet. Add them under Compliance Checks.</p>}
              {shownChecks.map(check => (
                <label key={check.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                  <Checkbox checked={form.checkIds.has(check.id)} onCheckedChange={value => toggleCheck(check.id, value === true)} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    {check.title}
                    <span className="block text-xs text-muted-foreground">{[check.siteName ?? "Whole business", check.dueDate ? `due ${new Date(check.dueDate).toLocaleDateString("en-GB")}` : null].filter(Boolean).join(" · ")}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="equipment-notes">Notes</Label><Textarea id="equipment-notes" value={form.notes} onChange={e => update("notes", e.target.value)} rows={3} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportExtinguishersDialog({ sites, defaultSite, open, onOpenChange, onDone }: {
  sites: SiteOption[];
  defaultSite: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  // The page's site filter, else the user's working site.
  const workingSiteId = useWorkingSiteId();
  const [siteId, setSiteId] = useState(defaultSite !== ALL ? defaultSite : workingSiteId ? String(workingSiteId) : NO_SITE);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/equipment/import-extinguishers", {
        method: "POST", body: JSON.stringify({ siteId: siteId === NO_SITE ? null : Number(siteId) }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Unable to copy the extinguishers"));
      const result = await res.json() as { added: number; alreadyListed: number };
      toast({
        title: result.added ? `${result.added} extinguisher${result.added === 1 ? "" : "s"} added` : "Nothing new to add",
        description: result.alreadyListed ? `${result.alreadyListed} already on the list.` : undefined,
      });
      onDone();
      onOpenChange(false);
    } catch (error) {
      toast({ title: "Couldn't copy the extinguishers", description: (error as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={value => !busy && onOpenChange(value)}>
      <DialogContent className="max-w-md rounded-sm">
        <DialogHeader>
          <DialogTitle>Copy extinguishers from FireTrack</DialogTitle>
          <DialogDescription>Adds one item for each extinguisher location on your FireTrack list, so each can have its own label. Locations already on the list are skipped.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label>Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger aria-label="Site for the extinguishers"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SITE}>No particular site</SelectItem>
              {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={run} disabled={busy}>{busy ? "Copying…" : "Copy extinguishers"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EquipmentList({ site, sites }: { site: string; sites: SiteOption[] }) {
  const { activeClientId, hasService } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<EquipmentItem | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);

  const params = new URLSearchParams();
  if (site !== ALL) params.set("siteId", site);
  if (showArchived) params.set("includeArchived", "true");
  const query = useQuery({
    queryKey: ["equipment", activeClientId, site, showArchived],
    queryFn: () => readJson<EquipmentItem[]>(`/equipment${params.size ? `?${params}` : ""}`, "Unable to load the equipment list"),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["equipment"] });
    queryClient.invalidateQueries({ queryKey: ["equipment-labels"] });
  };

  const openDialog = (item: EquipmentItem | null) => {
    setEditing(item);
    setDialogKey(key => key + 1);
    setDialogOpen(true);
  };

  const setActive = async (item: EquipmentItem, active: boolean) => {
    const res = await apiFetch(`/equipment/${item.id}`, { method: "PUT", body: JSON.stringify({ active }) });
    if (!res.ok) {
      toast({ title: "Couldn't update the item", description: await getApiErrorMessage(res, "Please try again."), variant: "destructive" });
      return;
    }
    toast({ title: active ? "Item restored" : "Item archived", description: active ? undefined : "Its label now shows it is no longer in use." });
    refresh();
  };

  const items = query.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => openDialog(null)}><Plus className="mr-1.5 h-4 w-4" /> Add equipment</Button>
        {hasService("firetrack") && (
          <Button variant="outline" onClick={() => setImportOpen(true)}><Flame className="mr-1.5 h-4 w-4" /> Copy extinguishers from FireTrack</Button>
        )}
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={showArchived} onCheckedChange={value => setShowArchived(value === true)} /> Show archived
        </label>
      </div>

      {query.isLoading && <Card className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</Card>}
      {query.error && <Card className="p-6 text-sm text-red-700">{(query.error as Error).message}</Card>}
      {query.data && items.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">
          No equipment listed here yet. Add boilers, water tanks, calorifiers, lifts and anything else no track keeps a record of.
        </Card>
      )}

      <div className="grid gap-2">
        {items.map(item => (
          <Card key={item.id} className={`flex flex-wrap items-start gap-3 p-4 ${item.active ? "" : "opacity-60"}`}>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{item.name}</span>
                <Badge variant="secondary">{item.typeLabel}</Badge>
                {!item.active && <Badge variant="outline">Archived</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">
                {[item.siteName ?? "No particular site", item.location, [item.make, item.model].filter(Boolean).join(" "), item.serialNo ? `Serial ${item.serialNo}` : null].filter(Boolean).join(" · ")}
              </p>
              {item.complianceItems.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Checks: {item.complianceItems.map((check, index) => (
                    <span key={check.id}>{index > 0 && ", "}<Link href={`/items/${check.id}`} className="text-primary hover:underline">{check.title}</Link></span>
                  ))}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{item.labelCode ? <>Label <span className="font-mono tracking-widest">{item.labelCode}</span></> : "No label printed yet"}</p>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => openDialog(item)} aria-label={`Edit ${item.name}`}><Pencil className="h-4 w-4" /></Button>
              {item.active
                ? <Button size="sm" variant="ghost" onClick={() => setActive(item, false)} aria-label={`Archive ${item.name}`}><Archive className="h-4 w-4" /></Button>
                : <Button size="sm" variant="ghost" onClick={() => setActive(item, true)} aria-label={`Restore ${item.name}`}><RotateCcw className="h-4 w-4" /></Button>}
            </div>
          </Card>
        ))}
      </div>

      <ItemDialog key={dialogKey} item={editing} sites={sites} defaultSite={site} open={dialogOpen} onOpenChange={setDialogOpen} onSaved={refresh} />
      {importOpen && <ImportExtinguishersDialog sites={sites} defaultSite={site} open={importOpen} onOpenChange={setImportOpen} onDone={refresh} />}
    </div>
  );
}

function LabelPrinting({ site }: { site: string }) {
  const { activeClientId } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [track, setTrack] = useState(ALL);
  const [size, setSize] = useState<"standard" | "large">("standard");
  const [printing, setPrinting] = useState(false);
  const [replacing, setReplacing] = useState<EquipmentLabelTarget | null>(null);

  const query = useQuery({
    queryKey: ["equipment-labels", activeClientId, site],
    queryFn: () => readJson<EquipmentLabelTarget[]>(`/equipment-labels${siteParam(site)}`, "Unable to load the items"),
  });
  const targets = query.data ?? [];
  const keyOf = (target: EquipmentLabelTarget) => `${target.kind}:${target.ref}`;
  const tracks = useMemo(() => [...new Set(targets.map(t => t.track))].sort(), [targets]);
  const shown = targets.filter(target => (track === ALL || target.track === track)
    && (!search.trim() || `${target.name} ${target.detail ?? ""} ${target.code ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));
  const allShownSelected = shown.length > 0 && shown.every(t => selected.has(keyOf(t)));

  const toggle = (target: EquipmentLabelTarget, on: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      if (on) next.add(keyOf(target)); else next.delete(keyOf(target));
      return next;
    });
  };
  const selectShown = (on: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      for (const target of shown) { if (on) next.add(keyOf(target)); else next.delete(keyOf(target)); }
      return next;
    });
  };
  const selectUnlabelled = () => setSelected(new Set(shown.filter(t => !t.code).map(keyOf)));

  const print = async (items: EquipmentLabelTarget[]) => {
    if (!items.length) return;
    setPrinting(true);
    try {
      const res = await apiFetch("/equipment-labels/sheet", {
        method: "POST", body: JSON.stringify({ items: items.map(t => ({ kind: t.kind, ref: t.ref })), size }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Unable to make the label sheet"));
      downloadBlob(await res.blob(), `qr-labels-${new Date().toISOString().slice(0, 10)}.pdf`);
      toast({ title: "Label sheet downloaded", description: "Print it at 100% (actual size) on A4 label sheets." });
      queryClient.invalidateQueries({ queryKey: ["equipment-labels"] });
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
    } catch (error) {
      toast({ title: "Couldn't make the label sheet", description: (error as Error).message, variant: "destructive" });
    } finally {
      setPrinting(false);
    }
  };

  const replace = async (target: EquipmentLabelTarget) => {
    const res = await apiFetch("/equipment-labels/replace", { method: "POST", body: JSON.stringify({ kind: target.kind, ref: target.ref }) });
    if (!res.ok) {
      toast({ title: "Couldn't replace the label", description: await getApiErrorMessage(res, "Please try again."), variant: "destructive" });
      return;
    }
    const updated = await res.json() as EquipmentLabelTarget;
    toast({ title: `New label ${updated.code}`, description: "The old label no longer works. Print the new one and stick it on." });
    queryClient.invalidateQueries({ queryKey: ["equipment-labels"] });
    queryClient.invalidateQueries({ queryKey: ["equipment"] });
    setSelected(new Set([keyOf(updated)]));
  };

  const selectedTargets = targets.filter(t => selected.has(keyOf(t)));

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1.5">
          <Label>Label size</Label>
          <Select value={size} onValueChange={value => setSize(value as "standard" | "large")}>
            <SelectTrigger className="w-64" aria-label="Label size"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">Standard: 21 per A4 sheet (63.5 × 38.1 mm)</SelectItem>
              <SelectItem value="large">Large: 8 per A4 sheet (99.1 × 67.7 mm)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => print(selectedTargets)} disabled={printing || selectedTargets.length === 0}>
          {printing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
          Download {selectedTargets.length || ""} label{selectedTargets.length === 1 ? "" : "s"} (PDF)
        </Button>
        <p className="w-full text-xs text-muted-foreground">Use weatherproof (polyester) labels on mowers, outdoor plant and anything that gets wet.</p>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find an item" className="pl-8" aria-label="Find an item" />
        </div>
        <Select value={track} onValueChange={setTrack}>
          <SelectTrigger className="w-48" aria-label="Track"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every track</SelectItem>
            {tracks.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={selectUnlabelled}>Select items without a label</Button>
      </div>

      {query.isLoading && <Card className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</Card>}
      {query.error && <Card className="p-6 text-sm text-red-700">{(query.error as Error).message}</Card>}
      {query.data && shown.length === 0 && <Card className="p-6 text-sm text-muted-foreground">Nothing to label here. Add items in their tracks or on the Equipment list tab.</Card>}

      {shown.length > 0 && (
        <Card className="divide-y">
          <label className="flex items-center gap-3 px-4 py-2 text-sm font-medium">
            <Checkbox checked={allShownSelected} onCheckedChange={value => selectShown(value === true)} aria-label="Select every item shown" />
            {shown.length} item{shown.length === 1 ? "" : "s"}
          </label>
          {shown.map(target => (
            <div key={keyOf(target)} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Checkbox checked={selected.has(keyOf(target))} onCheckedChange={value => toggle(target, value === true)} aria-label={`Select ${target.name}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{target.name}</span>
                  <Badge variant="secondary" className="text-[11px]">{target.track}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{[target.detail, target.siteName].filter(Boolean).join(" · ")}</p>
              </div>
              <span className="text-xs text-muted-foreground">{target.code ? <span className="font-mono tracking-widest text-foreground">{target.code}</span> : "No label yet"}</span>
              {target.code && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => print([target])} disabled={printing}>Reprint</Button>
                  <Button size="sm" variant="ghost" onClick={() => setReplacing(target)}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Replace</Button>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      <AlertDialog open={!!replacing} onOpenChange={value => !value && setReplacing(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the label for {replacing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Use this when a label is lost, damaged or may have been copied. The old label ({replacing?.code}) stops working straight away and the item gets a new code to print. Records already made are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (replacing) void replace(replacing); setReplacing(null); }}>Replace label</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function EquipmentPage() {
  const { data: sites = [] } = useListSites();
  const [site, setSite] = useState(ALL);
  const siteOptions = sites.map(s => ({ id: s.id, name: s.name }));

  return (
    <AppLayout title="Equipment & QR labels">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Equipment & QR labels</h1>
          <p className="text-sm text-muted-foreground">Put a QR label on every item and by each track's checks. A phone scan shows whether it is in date and opens today's check, reading or fault report.</p>
        </div>
        <SetupGuide />
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-sm">Site</Label>
          <Select value={site} onValueChange={setSite}>
            <SelectTrigger className="w-56" aria-label="Site"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every site</SelectItem>
              <SelectItem value={NO_SITE}>No particular site</SelectItem>
              {siteOptions.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Tabs defaultValue="labels">
          <TabsList>
            <TabsTrigger value="labels">Print labels</TabsTrigger>
            <TabsTrigger value="list">Equipment list</TabsTrigger>
          </TabsList>
          <TabsContent value="labels" className="pt-2"><LabelPrinting site={site} /></TabsContent>
          <TabsContent value="list" className="pt-2"><EquipmentList site={site} sites={siteOptions} /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
