import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays, parseISO } from "date-fns";
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
  ConfirmDelete, DocumentField, SiteFilter, SiteSelect, addMonthsIso, downloadCsv, downloadRegisterDocument,
  ensureOk, fmtDate, todayIso, useRegisterList, useRegisterSites, type DocumentValue,
} from "@/components/register-shared";

// The COSHH register (API: /registers/coshh): hazardous substances at each
// site with their safety data sheets. One copy of this screen serves both
// places it appears:
//  - the free COSHH Register page (/coshh) for businesses without
//    COSHHTrack, where each substance also carries a simple assessment date,
//    review date and controls;
//  - COSHHTrack's Substances tab. There the full COSHH assessments live in
//    COSHHTrack, so those simple fields are hidden (and kept unchanged on
//    save) and each substance shows its COSHHTrack assessments instead.

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
  assessmentDate: string;
  reviewDue: string;
  reviewDueTouched: boolean;
  controls: string;
  status: "in_use" | "withdrawn";
}

const LIST_PATH = "/registers/coshh";

function reviewState(item: CoshhSubstance): "overdue" | "soon" | "ok" | "none" | "withdrawn" {
  if (item.status === "withdrawn") return "withdrawn";
  if (!item.reviewDue) return "none";
  if (item.reviewOverdue) return "overdue";
  return differenceInCalendarDays(parseISO(item.reviewDue), new Date()) <= 30 ? "soon" : "ok";
}

function ReviewBadge({ item }: { item: CoshhSubstance }) {
  const state = reviewState(item);
  const styles = {
    overdue: "border-red-300 bg-red-50 text-red-700",
    soon: "border-amber-300 bg-amber-50 text-amber-800",
    ok: "border-emerald-300 bg-emerald-50 text-emerald-700",
    none: "border-slate-300 bg-slate-50 text-slate-600",
    withdrawn: "border-slate-300 bg-slate-50 text-slate-600",
  }[state];
  const text = {
    overdue: `Review overdue (${fmtDate(item.reviewDue)})`,
    soon: `Review due ${fmtDate(item.reviewDue)}`,
    ok: `Review ${fmtDate(item.reviewDue)}`,
    none: "No review date",
    withdrawn: "Withdrawn",
  }[state];
  return <Badge variant="outline" className={cn("text-[11px] whitespace-nowrap", styles)}>{text}</Badge>;
}

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

export function CoshhRegisterPanel({ track }: { track?: CoshhTrackLinks }) {
  const canEdit = useCanEdit();
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { sites, siteName } = useRegisterSites();

  const [ownSiteFilter, setSiteFilter] = useState("all");
  const siteFilter = track ? track.siteFilter : ownSiteFilter;
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
    (track?.assessments ?? []).filter((a) => a.substanceId === substanceId && a.status === "current");
  const overdue = track
    ? inUse.filter((item) => currentAssessments(item.id).some((a) => a.reviewOverdue)).length
    : inUse.filter((item) => item.reviewOverdue).length;
  const unassessed = track ? inUse.filter((item) => currentAssessments(item.id).length === 0).length : 0;
  const missingSds = inUse.filter((item) => !item.sdsObjectPath).length;

  function openNew() {
    const today = todayIso();
    setEditing(null);
    setForm({
      siteId: siteFilter !== "all" ? siteFilter : sites.length === 1 ? String(sites[0].id) : "",
      productName: "", supplier: "", hazardPictograms: [], whereUsed: "",
      document: { objectPath: null, fileName: null },
      // In COSHHTrack the review date belongs to the COSHH assessment, not the register entry.
      assessmentDate: track ? "" : today, reviewDue: track ? "" : addMonthsIso(today, 12), reviewDueTouched: !!track,
      controls: "", status: "in_use",
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
      assessmentDate: item.assessmentDate ?? "",
      reviewDue: item.reviewDue ?? "",
      reviewDueTouched: true,
      controls: item.controls ?? "",
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
          assessmentDate: form.assessmentDate || null,
          reviewDue: form.reviewDue || null,
          controls: form.controls || null,
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
    if (added > 0) toast({ title: added === 1 ? "1 substance added" : `${added} substances added`, description: track ? "Attach each safety data sheet, then assess each one." : "Attach each safety data sheet and record the assessment." });
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
    if (track) {
      downloadCsv(`coshh-substances-${todayIso()}.csv`,
        ["Site", "Product", "Supplier", "Hazard pictograms", "Where used", "Safety data sheet", "COSHH assessments", "Status"],
        visible.map((item) => [
          siteName(item.siteId), item.productName, item.supplier ?? "",
          item.hazardPictograms.map((k) => PICTOGRAM_LABEL[k] ?? k).join("; "), item.whereUsed ?? "",
          item.sdsFileName ?? (item.sdsObjectPath ? "Attached" : "Missing"),
          currentAssessments(item.id).map((a) => `${a.task}${a.reviewDue ? ` (review ${fmtDate(a.reviewDue)})` : ""}`).join("; ") || "None",
          item.status === "in_use" ? "In use" : "Withdrawn",
        ]));
      return;
    }
    downloadCsv(`coshh-register-${todayIso()}.csv`,
      ["Site", "Product", "Supplier", "Hazard pictograms", "Where used", "Safety data sheet", "Assessment date", "Review due", "Review overdue", "Controls / PPE", "Status"],
      visible.map((item) => [
        siteName(item.siteId), item.productName, item.supplier ?? "",
        item.hazardPictograms.map((k) => PICTOGRAM_LABEL[k] ?? k).join("; "), item.whereUsed ?? "",
        item.sdsFileName ?? (item.sdsObjectPath ? "Attached" : "Missing"),
        fmtDate(item.assessmentDate), fmtDate(item.reviewDue), item.reviewOverdue ? "Yes" : "No",
        item.controls ?? "", item.status === "in_use" ? "In use" : "Withdrawn",
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
          {track?.onAssess && (
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
          <button key={a.id} type="button" className="text-left text-xs hover:underline" onClick={() => track?.onOpenAssessment?.(a.id)}>
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
        <div className={cn("grid gap-2", track ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3")}>
          <div className="border border-border rounded-sm p-3">
            <p className="text-xs text-muted-foreground">In use</p>
            <p className="text-xl font-bold">{inUse.length}</p>
          </div>
          <div className={cn("border rounded-sm p-3", overdue > 0 ? "border-red-300 bg-red-50" : "border-border")}>
            <p className={cn("text-xs", overdue > 0 ? "text-red-700" : "text-muted-foreground")}>Reviews overdue</p>
            <p className={cn("text-xl font-bold", overdue > 0 && "text-red-700")}>{overdue}</p>
          </div>
          {track && (
            <div className={cn("border rounded-sm p-3", unassessed > 0 ? "border-amber-300 bg-amber-50" : "border-border")}>
              <p className={cn("text-xs", unassessed > 0 ? "text-amber-800" : "text-muted-foreground")}>No COSHH assessment</p>
              <p className={cn("text-xl font-bold", unassessed > 0 && "text-amber-800")}>{unassessed}</p>
            </div>
          )}
          <div className={cn("border rounded-sm p-3", missingSds > 0 ? "border-amber-300 bg-amber-50" : "border-border")}>
            <p className={cn("text-xs", missingSds > 0 ? "text-amber-800" : "text-muted-foreground")}>No data sheet</p>
            <p className={cn("text-xl font-bold", missingSds > 0 && "text-amber-800")}>{missingSds}</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            {!track && <SiteFilter value={siteFilter} onChange={setSiteFilter} />}
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
                    <th className="p-2 font-medium">{track ? "Where used" : "Where used / controls"}</th>
                    <th className="p-2 font-medium">{track ? "COSHH assessment" : "Assessment"}</th>
                    <th className="p-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.id} className={cn("border-t border-border align-top", !track && item.reviewOverdue && "bg-red-50/40")}>
                      <td className="p-2">
                        <p className="font-medium">{item.productName}</p>
                        <p className="text-xs text-muted-foreground">{[item.supplier, siteName(item.siteId)].filter(Boolean).join(" · ")}</p>
                        {!item.sdsObjectPath && item.status === "in_use" && <p className="text-xs text-amber-700 mt-1">No safety data sheet attached</p>}
                      </td>
                      <td className="p-2"><div className="flex flex-wrap gap-1 max-w-[220px]">{pictogramBadges(item)}</div></td>
                      <td className="p-2 text-xs max-w-[280px]">
                        {item.whereUsed && <p>{item.whereUsed}</p>}
                        {!track && item.controls && <p className="text-muted-foreground mt-1 whitespace-pre-wrap">{item.controls}</p>}
                      </td>
                      <td className="p-2 text-xs space-y-1">
                        {track ? trackAssessments(item) : (
                          <>
                            <p className="text-muted-foreground">Assessed {item.assessmentDate ? fmtDate(item.assessmentDate) : "—"}</p>
                            <ReviewBadge item={item} />
                          </>
                        )}
                      </td>
                      <td className="p-2">{actions(item)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="lg:hidden space-y-3">
              {visible.map((item) => (
                <div key={item.id} className={cn("rounded-xl border p-3 space-y-2", !track && item.reviewOverdue ? "border-red-300" : "border-border")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{item.productName}</p>
                      <p className="text-xs text-muted-foreground">{[item.supplier, siteName(item.siteId)].filter(Boolean).join(" · ")}</p>
                    </div>
                    {actions(item)}
                  </div>
                  <div className="flex flex-wrap gap-1">{pictogramBadges(item)}</div>
                  {item.whereUsed && <p className="text-xs">Used: {item.whereUsed}</p>}
                  {!track && item.controls && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{item.controls}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    {track ? trackAssessments(item) : <ReviewBadge item={item} />}
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
            <DialogDescription>{track ? "Take the hazard pictograms from the supplier's safety data sheet." : "Take the hazard pictograms and controls from the supplier's safety data sheet."}</DialogDescription>
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
              {track ? (
                <p className="text-xs text-muted-foreground">Record the COSHH assessment for this substance on the Assessments tab.</p>
              ) : (<>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="coshh-assessed">COSHH assessment date</Label>
                  <Input id="coshh-assessed" type="date" value={form.assessmentDate} onChange={(e) => {
                    const assessmentDate = e.target.value;
                    setForm({
                      ...form,
                      assessmentDate,
                      reviewDue: form.reviewDueTouched || !assessmentDate ? form.reviewDue : addMonthsIso(assessmentDate, 12),
                    });
                  }} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="coshh-review">Review due</Label>
                  <Input id="coshh-review" type="date" value={form.reviewDue} onChange={(e) => setForm({ ...form, reviewDue: e.target.value, reviewDueTouched: true })} />
                  <p className="text-[11px] text-muted-foreground">Suggested: 12 months after the assessment. Change it to suit.</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="coshh-controls">Controls and PPE</Label>
                <Textarea id="coshh-controls" rows={3} value={form.controls} maxLength={4000}
                  placeholder="For example: use in a ventilated area, nitrile gloves and eye protection, store locked away from food"
                  onChange={(e) => setForm({ ...form, controls: e.target.value })} />
              </div>
              </>)}
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
