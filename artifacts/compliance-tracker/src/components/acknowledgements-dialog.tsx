import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useLiveAcknowledgements } from "@/hooks/use-live-acknowledgements";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { CheckCircle2, CheckSquare, Clock, Loader2, Printer, Users } from "lucide-react";
import { cn } from "@/lib/utils";

/** The document fields the dialog needs (DocTrack's library and TrainTrack's Documents tab). */
export interface AcknowledgementDoc {
  id: number;
  title: string;
  department: string | null;
  site_id: number | null;
}

export interface StaffMember {
  id: number;
  name: string;
  job_title: string | null;
  department: string | null;
  site_id: number | null;
  active: boolean;
}

interface Acknowledgement {
  id: number;
  staff_roster_id: number;
  staff_name: string;
  signature: string | null;
  acknowledged_at: string;
  expiry_date?: string | null;
  acknowledgement_status?: "pending" | "acknowledged" | "expired";
}

/** Who must read and sign a DocTrack document, and recording sign-offs for them (managers). */
export function AcknowledgementsDialog({ doc, open, onClose, canExport }: {
  doc: AcknowledgementDoc; open: boolean; onClose: () => void; canExport: boolean;
}) {
  const { toast } = useToast();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [acks, setAcks] = useState<Acknowledgement[]>([]);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [sigs, setSigs] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deptFilter, setDeptFilter] = useState("all");

  async function handleExportRegister() {
    setExporting(true);
    try {
      const response = await apiFetch(`/doc-track/documents/${doc.id}/acknowledgements/export`);
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${doc.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "document"}-acknowledgements.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "PDF export failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setDeptFilter("all");
    Promise.all([
      apiFetch("/staff-roster").then(r => r.ok ? r.json() : []),
      apiFetch(`/doc-track/documents/${doc.id}/acknowledgements`).then(r => r.ok ? r.json() : []),
    ]).then(([s, a]) => {
      // Only staff the API will accept for this document (same rule as
      // findEligibleRosterMember: active, and in its department and site when set).
      setStaff((s as StaffMember[]).filter(m =>
        m.active
        && (!doc.department || m.department === doc.department)
        && (doc.site_id == null || m.site_id === doc.site_id),
      ));
      setAcks(a);
      setChecked({});
      setSigs({});
    }).finally(() => setLoading(false));
  }, [open, doc.id, doc.department, doc.site_id]);

  // Pick up signatures staff record on their own devices while this is open.
  useLiveAcknowledgements(open && !loading ? `/doc-track/documents/${doc.id}/acknowledgements` : null, acks, setAcks);

  const ackedIds = new Set(acks.map((a: Acknowledgement) => a.staff_roster_id));
  const ackedMap = Object.fromEntries(acks.map(a => [a.staff_roster_id, a]));

  // Department filter
  const departments = ["all", ...Array.from(new Set(staff.map(s => s.department).filter(Boolean) as string[])).sort()];
  const visibleStaff = deptFilter === "all" ? staff : staff.filter(s => s.department === deptFilter);
  const unacked = visibleStaff.filter(s => !ackedIds.has(s.id));
  const acked   = visibleStaff.filter(s => ackedIds.has(s.id));

  // Counts across ALL staff (for the footer summary)
  const totalAcked = staff.filter(s => ackedIds.has(s.id)).length;

  // Someone ticked here may have since signed on their own device.
  const anyChecked = staff.some(s => checked[s.id] && !ackedIds.has(s.id));

  async function handleSave() {
    const toSave = staff.filter(s => checked[s.id] && !ackedIds.has(s.id));
    if (!toSave.length) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/doc-track/documents/${doc.id}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({
          acknowledgements: toSave.map(s => ({
            staffRosterId: s.id,
            staffName: s.name,
            signature: sigs[s.id]?.trim() || null,
          })),
        }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast({ title: `${data.created} acknowledgement${data.created === 1 ? "" : "s"} recorded`, description: "TrainTrack sign-off records created automatically." });
      const fresh = await apiFetch(`/doc-track/documents/${doc.id}/acknowledgements`);
      if (fresh.ok) setAcks(await fresh.json());
      setChecked({});
      setSigs({});
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function toggleAll() {
    if (unacked.every(s => checked[s.id])) {
      const cleared = { ...checked };
      unacked.forEach(s => { delete cleared[s.id]; });
      setChecked(cleared);
    } else {
      setChecked(prev => ({ ...prev, ...Object.fromEntries(unacked.map(s => [s.id, true])) }));
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckSquare className="w-4 h-4" /> Acknowledgements — {doc.title}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : staff.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No eligible staff in roster</p>
            <p className="text-sm mt-1">Add active staff in this document's department and site in <strong>Staff Roster</strong> before recording acknowledgements.</p>
          </div>
        ) : (
          <>
            {/* Department filter */}
            {departments.length > 2 && (
              <div className="flex flex-wrap gap-1.5 pb-1">
                {departments.map(d => (
                  <button
                    key={d}
                    onClick={() => { setDeptFilter(d); setChecked({}); }}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium transition-colors border",
                      deptFilter === d
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted/40 text-muted-foreground border-border hover:bg-muted",
                    )}
                  >
                    {d === "all" ? "All departments" : d}
                    {d !== "all" && (
                      <span className="ml-1.5 opacity-60">
                        {staff.filter(s => s.department === d && ackedIds.has(s.id)).length}/
                        {staff.filter(s => s.department === d).length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {/* Pending */}
              {unacked.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-muted-foreground">Pending ({unacked.length})</p>
                    <button onClick={toggleAll} className="text-xs text-primary hover:underline">
                      {unacked.every(s => checked[s.id]) ? "Deselect all" : "Select all"}
                    </button>
                  </div>
                  <div className="space-y-2">
                    {unacked.map(s => (
                      <div key={s.id} className={cn("border rounded-lg p-3 transition-colors", checked[s.id] ? "bg-primary/5 border-primary/30" : "")}>
                        <div className="flex items-center gap-3">
                          <Checkbox
                            checked={!!checked[s.id]}
                            onCheckedChange={v => setChecked(prev => ({ ...prev, [s.id]: !!v }))}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{s.name}</p>
                            {(s.job_title || s.department) && (
                              <p className="text-xs text-muted-foreground">{[s.job_title, s.department].filter(Boolean).join(" · ")}</p>
                            )}
                          </div>
                        </div>
                        {checked[s.id] && (
                          <div className="mt-2 ml-7">
                            <Input
                              placeholder="Signature (typed name) — optional"
                              value={sigs[s.id] ?? ""}
                              onChange={e => setSigs(prev => ({ ...prev, [s.id]: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Acknowledged */}
              {acked.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">Acknowledged ({acked.length})</p>
                  <div className="space-y-1.5">
                    {acked.map(s => {
                      const a = ackedMap[s.id];
                      return (
                        <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-green-50 border border-green-100">
                          <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{s.name}</p>
                            {(s.job_title || s.department) && (
                              <p className="text-xs text-muted-foreground">{[s.job_title, s.department].filter(Boolean).join(" · ")}</p>
                            )}
                            {a?.signature && (a.signature.startsWith("data:image/")
                              ? <img src={a.signature} alt={`Signature of ${s.name}`} className="h-8 mt-1 bg-white rounded border" />
                              : <p className="text-xs text-muted-foreground">Signed: {a.signature}</p>)}
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(a.acknowledged_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {unacked.length === 0 && acked.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">No staff in this department.</p>
              )}
            </div>
          </>
        )}

        <DialogFooter className="pt-3 border-t mt-2 gap-2 sm:gap-0">
          <span className="text-xs text-muted-foreground mr-auto">
            {totalAcked}/{staff.length} acknowledged overall · TrainTrack records created automatically
          </span>
          {canExport && !loading && staff.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleExportRegister} className="gap-1.5" disabled={saving || exporting}>
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
              Export PDF
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          {unacked.length > 0 && (
            <Button onClick={handleSave} disabled={!anyChecked || saving}>
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Record Acknowledgements
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
