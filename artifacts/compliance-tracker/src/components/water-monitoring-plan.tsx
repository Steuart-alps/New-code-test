import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/context/auth-context";
import { apiFetch, getApiErrorMessage } from "@/lib/api";

type Module = "legionella" | "pool-track" | "hot-tub";
type Profile = {
  riskAssessmentReference?: string;
  writtenSchemeReference?: string;
  competentPerson?: string;
  frequencyDays?: Record<string, number>;
  frequencyHours?: Record<string, number>;
  approvedAt?: string | null;
  reviewRequired?: boolean;
  materialChangeNote?: string | null;
};

export function WaterMonitoringPlan({
  module, siteId, checks, unit, canManage, onChanged,
}: {
  module: Module;
  siteId?: number;
  checks: Record<string, string>;
  unit: "days" | "hours";
  canManage: boolean;
  onChanged: () => void;
}) {
  const { activeClientId } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [riskAssessmentReference, setRiskAssessmentReference] = useState("");
  const [writtenSchemeReference, setWrittenSchemeReference] = useState("");
  const [competentPerson, setCompetentPerson] = useState("");
  const [frequencies, setFrequencies] = useState<Record<string, string>>({});
  const [changeNote, setChangeNote] = useState("");
  const hydratedFor = useRef<string | null>(null);

  const queryKey = ["water-monitoring-plan", module, siteId, activeClientId];
  const { data, isLoading, error } = useQuery<{ profile: Profile; approved: boolean }>({
    queryKey,
    queryFn: async () => {
      const response = await apiFetch(`/${module}/monitoring-plan?siteId=${siteId}`);
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load the site plan"));
      return response.json();
    },
    enabled: !!siteId && !!activeClientId,
  });

  useEffect(() => {
    if (!open) {
      hydratedFor.current = null;
      return;
    }
    if (!data) return;
    const key = `${module}:${siteId}`;
    if (hydratedFor.current === key) return;
    hydratedFor.current = key;
    const p = data?.profile ?? {};
    setRiskAssessmentReference(p.riskAssessmentReference ?? "");
    setWrittenSchemeReference(p.writtenSchemeReference ?? "");
    setCompetentPerson(p.competentPerson ?? "");
    const stored = unit === "hours" ? p.frequencyHours : p.frequencyDays;
    setFrequencies(Object.fromEntries(Object.keys(checks).map(key => [key, stored?.[key]?.toString() ?? ""])));
    setChangeNote("");
  }, [open, data, unit, checks, module, siteId]);

  async function save(action: "approve" | "flag_change") {
    if (!siteId) return;
    const values = Object.fromEntries(Object.entries(frequencies).map(([key, value]) => [key, Number(value)]));
    if (action === "approve") {
      if (!riskAssessmentReference.trim() || !writtenSchemeReference.trim() || !competentPerson.trim() ||
          Object.keys(checks).some(key => !/^[1-9]\d*$/.test(frequencies[key] ?? ""))) {
        toast({ title: "Complete the site plan", description: "Enter the references, competent person and every monitoring frequency.", variant: "destructive" });
        return;
      }
      if (!window.confirm("Confirm that the appointed competent person has reviewed this risk assessment, written scheme and monitoring schedule for this site. Approve the plan?")) return;
    } else if (!changeNote.trim()) {
      toast({ title: "Describe the material change", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const response = await apiFetch(`/${module}/monitoring-plan?siteId=${siteId}`, {
        method: "PUT",
        body: JSON.stringify(action === "approve"
          ? { action, riskAssessmentReference, writtenSchemeReference, competentPerson, frequencies: values }
          : { action, materialChangeNote: changeNote }),
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not save the site plan"));
      await queryClient.invalidateQueries({ queryKey });
      onChanged();
      toast({ title: action === "approve" ? "Site monitoring plan approved" : "Competent-person review required" });
      setOpen(false);
    } catch (error) {
      toast({ title: "Plan not saved", description: error instanceof Error ? error.message : "Please try again", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!siteId) return (
    <div className="rounded-sm border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      Select a site to view its risk-assessed monitoring schedule. No generic interval is used to mark checks as up to date.
    </div>
  );
  if (error) return (
    <div role="alert" className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      Could not load the site monitoring plan. Due states cannot be verified until it loads.
      <Button size="sm" variant="outline" className="ml-3" onClick={() => queryClient.invalidateQueries({ queryKey })}>Retry</Button>
    </div>
  );

  return (
    <div className="rounded-sm border p-3 flex flex-wrap items-center justify-between gap-3 text-sm">
      <div>
        <strong>{isLoading ? "Loading site plan…" : data?.approved ? "Approved site monitoring plan" : "Site monitoring plan required"}</strong>
        <p className="text-xs text-muted-foreground mt-1">
          {data?.profile.reviewRequired
            ? `Material change: ${data.profile.materialChangeNote || "review needed"}. Ask the competent person to review the risk assessment and written scheme before approval.`
            : data?.approved
              ? `Risk assessment: ${data.profile.riskAssessmentReference} · Written scheme: ${data.profile.writtenSchemeReference} · Competent person: ${data.profile.competentPerson}`
              : "A manager must record the risk assessment, written scheme, competent person and local frequencies before due states can be shown."}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          After changes to the installation, use, water treatment, or significant failed checks, seek a competent-person review and revise the site plan.
        </p>
      </div>
      {canManage && <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={isLoading}>Review site plan</Button>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Risk-assessed monitoring plan</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            Record the controls from this site's written scheme. These fields support the scheme; they do not replace the risk assessment or competent-person advice.
          </p>
          <div className="space-y-3">
            <div><Label>Risk assessment reference</Label><Input value={riskAssessmentReference} onChange={e => setRiskAssessmentReference(e.target.value)} /></div>
            <div><Label>Written scheme / operating procedure reference</Label><Input value={writtenSchemeReference} onChange={e => setWrittenSchemeReference(e.target.value)} /></div>
            <div><Label>Appointed competent person</Label><Input value={competentPerson} onChange={e => setCompetentPerson(e.target.value)} /></div>
            <div>
              <Label>Site monitoring frequencies (every {unit})</Label>
              <div className="grid sm:grid-cols-2 gap-2 mt-2">
                {Object.entries(checks).map(([key, label]) =>
                  <div key={key}><Label className="text-xs">{label}</Label>
                    <Input type="number" min={1} step={1} max={unit === "hours" ? 87600 : 3650}
                      value={frequencies[key] ?? ""} onChange={e => setFrequencies(f => ({ ...f, [key]: e.target.value }))} />
                  </div>
                )}
              </div>
            </div>
            <div className="border-t pt-3">
              <Label>Material change requiring review</Label>
              <Textarea rows={2} placeholder="What changed at this site?" value={changeNote} onChange={e => setChangeNote(e.target.value)} />
              <Button variant="outline" className="mt-2" disabled={saving} onClick={() => save("flag_change")}>Flag for competent-person review</Button>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={saving} onClick={() => save("approve")}>{saving ? "Saving…" : "Approve site plan"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}