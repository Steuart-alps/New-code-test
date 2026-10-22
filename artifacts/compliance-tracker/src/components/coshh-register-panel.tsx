import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Download, FileText, Mic, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { CoshhSpeakListDialog } from "@/components/coshh-speak-list-dialog";
import { dictationSupported } from "@/components/dictation-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCanEdit } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ConfirmDelete, DocumentField, SiteSelect, downloadCsv, downloadRegisterDocument,
  ensureOk, fmtDate, todayIso, useRegisterList, useRegisterSites, type DocumentValue,
} from "@/components/register-shared";

// COSHHTrack's Substances tab: the COSHH register (API: /registers/coshh),
// hazardous substances at each site with their safety data sheets. Each
// substance shows its COSHHTrack assessments. Register entries made before
// the register moved into COSHHTrack may carry a simple assessment date,
// review date and controls; they are no longer edited here but are kept
// unchanged on save.

// GHS hazard pictograms (GB CLP). Keys match the API.
const PICTOGRAMS = [
  { key: "ghs01", label: "Explosive", code: "GHS01" },
  { key: "ghs02", label: "Flammable", code: "GHS02" },
  { key: "ghs03", label: "Oxidising", code: "GHS03" },
  { key: "ghs04", label: "Gas under pressure", code: "GHS04" },
  { key: "ghs05", label: "Corrosive", code: "GHS05" },
  { key: "ghs06", label: "Acute toxicity (toxic)", code: "GHS06" },
  { key: "ghs07", label: "Harmful / irritant", code: "GHS07" },
  { key: "ghs08", label: "Serious health hazard", code: "GHS08" },
  { key: "ghs09", label: "Hazardous to the environment", code: "GHS09" },
] as const;
const PICTOGRAM_LABEL: Record<string, string> = Object.fromEntries(PICTOGRAMS.map((p) => [p.key, p.label]));

export interface CoshhSubstance {
  id: number;
  siteId: number | null;
  productName: string;
  supplier: string | null;
  hazardPictograms: string[];
  whereUsed: string | null;
  sdsObjectPath: string | null;
  sdsFileName: string | null;
  assessmentDate: string | null;
  reviewDue: string | null;
  controls: string | null;
  status: "in_use" | "withdrawn";
  reviewOverdue: boolean;
}

interface FormState {
  siteId: string;
  productName: string;
  supplier: string;
  hazardPictograms: string[];
  whereUsed: string;
  document: DocumentValue;
  // Earlier register fields, re-sent unchanged (the API clears omitted ones).
  assessmentDate: string | null;
  reviewDue: string | null;
  controls: string | null;
  status: "in_use" | "withdrawn";
}

const LIST_PATH = "/registers/coshh";

/** A COSHHTrack assessment, as the Substances tab shows it against its substance. */
export interface TrackAssessmentLink {
  id: number;
  substanceId: number | null;
  task: string;
  status: "current" | "archived";
  reviewDue: string | null;
  reviewOverdue: boolean;
}

export interface CoshhTrackLinks {
  assessments: TrackAssessmentLink[];
  /** Opens a new COSHHTrack assessment for the substance; absent when the caller can't write one. */
  onAssess?: (substance: CoshhSubstance) => void;
  /** Opens an existing assessment. */
  onOpenAssessment?: (assessmentId: number) => void;
  /** COSHHTrack's own site filter, which this tab follows instead of showing a second one. */
  siteFilter: string;
}

export function CoshhRegisterPanel({ track }: { track: CoshhTrackLinks }) {
  const canEdit = useCanEdit();
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { sites, siteName } = useRegisterSites();

  const { siteFilter } = track;
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<CoshhSubstance | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CoshhSubstance | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const { data: items = [], isLoading, error } = useRegisterList<CoshhSubstance>(LIST_PATH);
  const visible = useMemo(() => items.filter((item) =>
    (siteFilter === "all" || String(item.siteId) === siteFilter)
    && (showWithdrawn || item.status === "in_use")
    && (!q || `${item.productName} ${item.supplier ?? ""} ${item.whereUsed ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  ), [items, siteFilter, showWithdrawn, q]);
  const inUse = items.filter((item) => item.status === "in_use" && (siteFilter === "all" || String(item.siteId) === siteFilter));
  const currentAssessments = (substanceId: number) =>
    track.assessments.filter((a) => a.substanceId === substanceId && a.status === "current");
  const overdue = inUse.filter((item) => currentAssessments(item.id).some((a) => a.reviewOverdue)).length;
  const unassessed = inUse.filter((item) => currentAssessments(item.id).length === 0).length;
  const missingSds = inUse.filter((item) => !item.sdsObjectPath).length;

  function openNew() {
    setEditing(null);
    setForm({
      siteId: siteFilter !== "all" ? siteFilter : sites.length === 1 ? String(sites[0].id) : "",
      productName: "", supplier: "", hazardPictograms: [], whereUsed: "",
      document: { objectPath: null, fileName: null },
      assessmentDate: null, reviewDue: null, controls: null, status: "in_use",
    });
  }

  function openEdit(item: CoshhSubstance) {
    setEditing(item);
    setForm({
      siteId: item.siteId == null ? "" : String(item.siteId),
      productName: item.productName,
      supplier: item.supplier ?? "",
      hazardPictograms: [...item.hazardPictograms],
      whereUsed: item.whereUsed ?? "",
      document: { objectPath: item.sdsObjectPath, fileName: item.sdsFileName },
      assessmentDate: item.assessmentDate,
      reviewDue: item.reviewDue,
      controls: item.controls,
      status: item.status,
    });
  }

  async function save() {
    if (!form) return;
    if (!form.siteId) { toast({ title: "Choose a site", variant: "destructive" }); return; }
    if (!form.productName.trim()) { toast({ title: "Enter the product name", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await ensureOk(await api(editing ? `${LIST_PATH}/${editing.id}` : LIST_PATH, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({
          siteId: Number(form.siteId),
          productName: form.productName,
          supplier: form.supplier || null,
          hazardPictograms: form.hazardPictograms,
          whereUsed: form.whereUsed || null,
          objectPath: form.document.objectPath,
          fileName: form.document.fileName,
          assessmentDate: form.assessmentDate,
          reviewDue: form.reviewDue,
          controls: form.controls,
          status: form.status,
        }),
      }), "Could not save");
      toast({ title: editing ? "Substance updated" : "Substance added" });
      setForm(null);
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: [`/api${LIST_PATH}`] });
    } catch (err) {
      toast({ title: "Could not save", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // Adds each product from a spoken or typed list; returns the ones that failed.
  async function addList(siteId: number, productNames: string[]): Promise<string[]> {
    const failed: string[] = [];
    let firstError: string | undefined;
    for (const productName of productNames) {
      try {
        await ensureOk(await api(LIST_PATH, { method: "POST", body: JSON.stringify({ siteId, productName }) }), "Could not add");
      } catch (err) {
        failed.push(productName);
        firstError ??= err instanceof Error ? err.message : undefined;
      }
    }
    await queryClient.invalidateQueries({ queryKey: [`/api${LIST_PATH}`] });
    const added = productNames.length - failed.length;
    if (added > 0) toast({ title: added === 1 ? "1 substance added" : `${added} substances added`, description: "Attach each safety data sheet, then assess each one." });
    if (failed.length > 0) toast({ title: `${failed.length} could not be added`, description: firstError, variant: "destructive" });
    return failed;
  }

  async function remove() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await ensureOk(await api(`${LIST_PATH}/${target.id}`, { method: "DELETE" }), "Could not remove");
      toast({ title: "Removed from the register" });
      await queryClient.invalidateQueries({ queryKey: [`/api${LIST_PATH}`] });
    } catch (err) {
      toast({ title: "Could not remove", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  async function downloadSds(item: CoshhSubstance) {
    try {
      await downloadRegisterDocument(api, `${LIST_PATH}/${item.id}/sds-url`, "safety-data-sheet");
    } catch (err) {
      toast({ title: "Download failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  function exportCsv() {
    downloadCsv(`coshh-substances-${todayIso()}.csv`,
      ["Site", "Product", "Supplier", "Hazard pictograms", "Where used", "Safety data sheet", "COSHH assessments", "Status"],
      visible.map((item) => [
        siteName(item.siteId), item.productName, item.supplier ?? "",
        item.hazardPictograms.map((k) => PICTOGRAM_LABEL[k] ?? k).join("; "), item.whereUsed ?? "",
        item.sdsFileName ?? (item.sdsObjectPath ? "Attached" : "Missing"),
        currentAssessments(item.id).map((a) => `${a.task}${a.reviewDue ? ` (review ${fmtDate(a.reviewDue)})` : ""}`).join("; ") || "None",
        item.status === "in_use" ? "In use" : "Withdrawn",
      ]));
  }

  const actions = (item: CoshhSubstance) => (
    <div className="flex items-center justify-end gap-1">
      {item.sdsObjectPath && (
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Download safety data sheet for ${item.productName}`} onClick={() => downloadSds(item)}>
          <FileText className="w-4 h-4" />
        </Button>
      )}
      {canEdit && (
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${item.productName}`} onClick={() => openEdit(item)}>
            <Pencil className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`Remove ${item.productName}`} onClick={() => setDeleteTarget(item)}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
  );

  // Substances tab: the substance's COSHHTrack assessments, or a prompt to assess it.
  const trackAssessments = (item: CoshhSubstance) => {
    const linked = currentAssessments(item.id);
    if (linked.length === 0) {
      if (item.status !== "in_use") return <span className="text-muted-foreground">Withdrawn</span>;
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[11px] border-amber-300 bg-amber-50 text-amber-800">No COSHH assessment</Badge>
          {item.assessmentDate && (
            // A date recorded on the register before the business had COSHHTrack.
            <span className="text-muted-foreground">Register says assessed {fmtDate(item.assessmentDate)}</span>
          )}
          {track.onAssess && (
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => track.onAssess!(item)}>
              <ClipboardCheck className="w-3.5 h-3.5" /> Assess
            </Button>
          )}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start gap-1">
        {linked.map((a) => (
          <button key={a.id} type="button" className="text-left text-xs hover:underline" onClick={() => track.onOpenAssessment?.(a.id)}>
            <span className="font-medium">{a.task}</span>{" "}
            <Badge variant="outline" className={cn("text-[10px] whitespace-nowrap", a.reviewOverdue ? "border-red-300 bg-red-50 text-red-700" : "border-emerald-300 bg-emerald-50 text-emerald-700")}>
              {a.reviewOverdue ? `Review overdue (${fmtDate(a.reviewDue)})` : a.reviewDue ? `Review ${fmtDate(a.reviewDue)}` : "Assessed"}
            </Badge>
          </button>
        ))}
      </div>
    );
  };

  const pictogramBadges = (item: CoshhSubstance) => item.hazardPictograms.length === 0
    ? <span className="text-xs text-muted-foreground">None recorded</span>
    : item.hazardPictograms.map((k) => <Badge key={k} variant="outline" className="text-[10px] border-orange-200 bg-orange-50 text-orange-800">{PICTOGRAM_LABEL[k] ?? k}</Badge>);

  return (
    <>
      <div className="space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="border border-border rounded-sm p-3">
            <p className="text-xs text-muted-foreground">In use</p>
            <p className="text-xl font-bold">{inUse.length}</p>
          </div>
          <div className={cn("border rounded-sm p-3", overdue > 0 ? "border-red-300 bg-red-50" : "border-border")}>
            <p className={cn("text-xs", overdue > 0 ? "text-red-700" : "text-muted-foreground")}>Reviews overdue</p>
            <p className={cn("text-xl font-bold", overdue > 0 && "text-red-700")}>{overdue}</p>
          </div>
          <div className={cn("border rounded-sm p-3", unassessed > 0 ? "border-amber-300 bg-amber-50" : "border-border")}>
            <p className={cn("text-xs", unassessed > 0 ? "text-amber-800" : "text-muted-foreground")}>No COSHH assessment</p>
            <p className={cn("text-xl font-bold", unassessed > 0 && "text-amber-800")}>{unassessed}</p>
          </div>
          <div className={cn("border rounded-sm p-3", missingSds > 0 ? "border-amber-300 bg-amber-50" : "border-border")}>
            <p className={cn("text-xs", missingSds > 0 ? "text-amber-800" : "text-muted-foreground")}>No data sheet</p>
            <p className={cn("text-xl font-bold", missingSds > 0 && "text-amber-800")}>{missingSds}</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input placeholder="Search substances…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 h-8 text-xs rounded-sm w-full sm:w-48" />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={showWithdrawn} onCheckedChange={(checked) => setShowWithdrawn(checked === true)} />
              Show withdrawn
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={exportCsv} disabled={visible.length === 0}>
              <Download className="w-3.5 h-3.5" /> Export CSV
            </Button>
            {canEdit && (
              <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={() => setListOpen(true)}>
                {dictationSupported ? <Mic className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                {dictationSupported ? "Speak a list" : "Add a list"}
              </Button>
            )}
            {canEdit && (
              <Button size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={openNew}>
                <Plus className="w-3.5 h-3.5" /> Add substance
              </Button>
            )}
          </div>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {!isLoading && !error && visible.length === 0 && (
          <div className="rounded-xl border-2 border-dashed border-muted py-12 text-center text-sm text-muted-foreground">
            {items.length === 0 ? "No substances recorded yet." : "No substances match this filter."}
          </div>
        )}

        {visible.length > 0 && (
          <>
            <div className="hidden lg:block border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Product</th>
                    <th className="p-2 font-medium">Hazards</th>
                    <th className="p-2 font-medium">Where used</th>
                    <th className="p-2 font-medium">COSHH assessment</th>
                    <th className="p-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.id} className={"border-t border-border align-top"}>
                      <td className="p-2">
                        <p className="font-medium">{item.productName}</p>
                        <p className="text-xs text-muted-foreground">{[item.supplier, siteName(item.siteId)].filter(Boolean).join(" · ")}</p>
                        {!item.sdsObjectPath && item.status === "in_use" && <p className="text-xs text-amber-700 mt-1">No safety data sheet attached</p>}
                      </td>
                      <td className="p-2"><div className="flex flex-wrap gap-1 max-w-[220px]">{pictogramBadges(item)}</div></td>
                      <td className="p-2 text-xs max-w-[280px]">
                        {item.whereUsed && <p>{item.whereUsed}</p>}
                      </td>
                      <td className="p-2 text-xs space-y-1">
                        {trackAssessments(item)}
                      </td>
                      <td className="p-2">{actions(item)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="lg:hidden space-y-3">
              {visible.map((item) => (
                <div key={item.id} className={"rounded-xl border border-border p-3 space-y-2"}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{item.productName}</p>
                      <p className="text-xs text-muted-foreground">{[item.supplier, siteName(item.siteId)].filter(Boolean).join(" · ")}</p>
                    </div>
                    {actions(item)}
                  </div>
                  <div className="flex flex-wrap gap-1">{pictogramBadges(item)}</div>
                  {item.whereUsed && <p className="text-xs">Used: {item.whereUsed}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    {trackAssessments(item)}
                    {!item.sdsObjectPath && item.status === "in_use" && <span className="text-xs text-amber-700">No safety data sheet</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <Dialog open={form !== null} onOpenChange={(open) => { if (!open) { setForm(null); setEditing(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit substance" : "Add substance"}</DialogTitle>
            <DialogDescription>Take the hazard pictograms from the supplier's safety data sheet.</DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SiteSelect value={form.siteId} onChange={(siteId) => setForm({ ...form, siteId })} />
                <div className="space-y-1.5">
                  <Label htmlFor="coshh-product">Product name *</Label>
                  <Input id="coshh-product" dictation value={form.productName} maxLength={200} onChange={(e) => setForm({ ...form, productName: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="coshh-supplier">Supplier</Label>
                  <Input id="coshh-supplier" dictation value={form.supplier} maxLength={200} onChange={(e) => setForm({ ...form, supplier: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="coshh-status">Status</Label>
                  <Select value={form.status} onValueChange={(status) => setForm({ ...form, status: status as FormState["status"] })}>
                    <SelectTrigger id="coshh-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="in_use">In use</SelectItem>
                      <SelectItem value="withdrawn">Withdrawn</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Hazard pictograms</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PICTOGRAMS.map((p) => (
                    <label key={p.key} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm cursor-pointer hover:bg-muted/40">
                      <Checkbox
                        checked={form.hazardPictograms.includes(p.key)}
                        onCheckedChange={(checked) => setForm({
                          ...form,
                          hazardPictograms: checked === true
                            ? [...form.hazardPictograms.filter((k) => k !== p.key), p.key]
                            : form.hazardPictograms.filter((k) => k !== p.key),
                        })}
                        className="mt-0.5"
                      />
                      <span>{p.label} <span className="text-xs text-muted-foreground">({p.code})</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-1.5">
                <Label htmlFor="coshh-where">Where and how it is used</Label>
                <Textarea id="coshh-where" rows={2} value={form.whereUsed} maxLength={1000} onChange={(e) => setForm({ ...form, whereUsed: e.target.value })} />
              </div>
              <DocumentField label="Safety data sheet" value={form.document} onChange={(document) => setForm({ ...form, document })} />
              <p className="text-xs text-muted-foreground">Record the COSHH assessment for this substance on the Assessments tab.</p>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setForm(null); setEditing(null); }} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CoshhSpeakListDialog
        open={listOpen}
        defaultSiteId={siteFilter !== "all" ? siteFilter : sites.length === 1 ? String(sites[0].id) : ""}
        existing={items}
        onClose={() => setListOpen(false)}
        onAdd={addList}
      />

      <ConfirmDelete
        open={deleteTarget !== null}
        title="Remove this substance?"
        description={`"${deleteTarget?.productName ?? ""}" will be removed from the register. If it is simply no longer used, set its status to Withdrawn instead.`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={remove}
      />
    </>
  );
}
