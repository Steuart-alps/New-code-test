import { useState, useMemo } from "react";
import { AppLayout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Anchor, Plus, AlertTriangle, CheckCircle2, XCircle, Clock,
  Pencil, Trash2, Search, ShieldAlert, Users, Activity,
  HeartPulse, Waves, ChevronDown,
} from "lucide-react";
import { useAuth, useCanAdmin } from "@/context/auth-context";

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");
async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_TYPE_LABELS: Record<string, string> = {
  public_swim:   "Public swim",
  lane_swim:     "Lane swim",
  club_session:  "Club session",
  lessons:       "Lessons",
  private_hire:  "Private hire",
  aquafit:       "Aquafit / class",
  other:         "Other",
};

const INCIDENT_TYPE_LABELS: Record<string, string> = {
  near_miss:        "Near miss",
  minor_injury:     "Minor injury",
  major_injury:     "Major injury",
  drowning_rescue:  "Drowning / rescue",
  pool_evacuation:  "Pool evacuation",
  medical:          "Medical emergency",
  other:            "Other",
};

const SEVERITY_LABELS: Record<string, string> = {
  low:      "Low",
  medium:   "Medium",
  high:     "High",
  critical: "Critical",
};

const FIRST_AID_ITEMS = [
  { key: "aedOk",          label: "AED / defibrillator" },
  { key: "firstAidKitOk",  label: "First-aid kit" },
  { key: "rescuePoleOk",   label: "Rescue pole" },
  { key: "throwBagOk",     label: "Throw bag / rope" },
  { key: "spineBoardOk",   label: "Spine board" },
  { key: "ringBuoyOk",     label: "Ring buoy" },
  { key: "oxygenKitOk",    label: "Oxygen kit" },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SwimSession {
  id: number;
  siteId: number | null;
  siteName: string | null;
  sessionDate: string;
  sessionType: string;
  lifeguardName: string | null;
  openTime: string | null;
  closeTime: string | null;
  maxBathers: number | null;
  batherCountPeak: number | null;
  preSessionResult: string;
  preSessionNotes: string | null;
  poolClosed: boolean;
  closureReason: string | null;
  notes: string | null;
  result: string;
}

interface SurveillanceCheck {
  id: number;
  sessionId: number | null;
  siteId: number | null;
  siteName: string | null;
  checkDate: string;
  checkTime: string | null;
  batherCount: number | null;
  scanCompleted: boolean;
  observations: string | null;
  checkedBy: string | null;
  result: string;
}

interface FirstAidCheck {
  id: number;
  siteId: number | null;
  siteName: string | null;
  checkDate: string;
  aedOk: boolean;
  firstAidKitOk: boolean;
  rescuePoleOk: boolean;
  throwBagOk: boolean;
  spineBoardOk: boolean;
  ringBuoyOk: boolean;
  oxygenKitOk: boolean;
  checkedBy: string | null;
  defectsFound: string | null;
  notes: string | null;
  result: string;
}

interface Incident {
  id: number;
  siteId: number | null;
  siteName: string | null;
  incidentDate: string;
  incidentTime: string | null;
  incidentType: string;
  severity: string;
  personsInvolved: string | null;
  description: string;
  actionTaken: string | null;
  reportedTo: string | null;
  reportedDate: string | null;
  outcome: string | null;
  notes: string | null;
}

interface StatusData {
  sessionsToday: number;
  poolsClosedToday: number;
  surveillanceToday: number;
  firstAidLast30d: number;
  firstAidActionRequired: number;
  lastFirstAidCheck: string | null;
  openIncidents: number;
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

function SessionDialog({
  open, onClose, session, sites, onSaved,
}: {
  open: boolean; onClose: () => void;
  session?: SwimSession | null;
  sites: { id: number; name: string }[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    siteId: "", sessionDate: today, sessionType: "public_swim", lifeguardName: "",
    openTime: "", closeTime: "", maxBathers: "", batherCountPeak: "",
    preSessionResult: "pass", preSessionNotes: "", poolClosed: false,
    closureReason: "", notes: "",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(session ? {
    siteId: session.siteId ? String(session.siteId) : "",
    sessionDate: session.sessionDate, sessionType: session.sessionType,
    lifeguardName: session.lifeguardName ?? "", openTime: session.openTime ?? "",
    closeTime: session.closeTime ?? "",
    maxBathers: session.maxBathers != null ? String(session.maxBathers) : "",
    batherCountPeak: session.batherCountPeak != null ? String(session.batherCountPeak) : "",
    preSessionResult: session.preSessionResult,
    preSessionNotes: session.preSessionNotes ?? "",
    poolClosed: session.poolClosed, closureReason: session.closureReason ?? "",
    notes: session.notes ?? "",
  } : blank);

  const handleSave = async () => {
    if (!form.sessionDate) return toast({ title: "Session date is required", variant: "destructive" });
    setSaving(true);
    try {
      const body = {
        siteId: form.siteId ? parseInt(form.siteId, 10) : null,
        sessionDate: form.sessionDate, sessionType: form.sessionType,
        lifeguardName: form.lifeguardName.trim() || null,
        openTime: form.openTime || null, closeTime: form.closeTime || null,
        maxBathers: form.maxBathers ? parseInt(form.maxBathers, 10) : null,
        batherCountPeak: form.batherCountPeak ? parseInt(form.batherCountPeak, 10) : null,
        preSessionResult: form.preSessionResult,
        preSessionNotes: form.preSessionNotes.trim() || null,
        poolClosed: form.poolClosed,
        closureReason: form.closureReason.trim() || null,
        notes: form.notes.trim() || null,
        result: form.poolClosed ? "fail" : form.preSessionResult,
      };
      if (session) {
        await apiFetch(`/swim-track/sessions/${session.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/swim-track/sessions", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: session ? "Session updated" : "Session logged" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{session ? "Edit Session" : "Log Pool Session"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.sessionDate}
                onChange={e => setForm(f => ({ ...f, sessionDate: e.target.value }))} />
            </div>
            <div>
              <Label>Session type</Label>
              <Select value={form.sessionType} onValueChange={v => setForm(f => ({ ...f, sessionType: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SESSION_TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {sites.length > 0 && (
              <div className="col-span-2">
                <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
                <Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">— All sites —</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label>Lifeguard on duty <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.lifeguardName}
                onChange={e => setForm(f => ({ ...f, lifeguardName: e.target.value }))} />
            </div>
            <div>
              <Label>Pre-session check result</Label>
              <Select value={form.preSessionResult} onValueChange={v => setForm(f => ({ ...f, preSessionResult: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">Pass</SelectItem>
                  <SelectItem value="advisory">Advisory</SelectItem>
                  <SelectItem value="fail">Fail</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Open time <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="time" className="mt-1 rounded-sm" value={form.openTime}
                onChange={e => setForm(f => ({ ...f, openTime: e.target.value }))} />
            </div>
            <div>
              <Label>Close time <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="time" className="mt-1 rounded-sm" value={form.closeTime}
                onChange={e => setForm(f => ({ ...f, closeTime: e.target.value }))} />
            </div>
            <div>
              <Label>Capacity limit <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" min="0" className="mt-1 rounded-sm" value={form.maxBathers}
                onChange={e => setForm(f => ({ ...f, maxBathers: e.target.value }))} placeholder="Max bathers" />
            </div>
            <div>
              <Label>Peak bather count <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" min="0" className="mt-1 rounded-sm" value={form.batherCountPeak}
                onChange={e => setForm(f => ({ ...f, batherCountPeak: e.target.value }))} />
            </div>
          </div>
          <div>
            <Label>Pre-session notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.preSessionNotes}
              onChange={e => setForm(f => ({ ...f, preSessionNotes: e.target.value }))}
              placeholder="Any observations from the pre-session check…" />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="poolClosed" checked={form.poolClosed}
              onChange={e => setForm(f => ({ ...f, poolClosed: e.target.checked }))} className="rounded" />
            <Label htmlFor="poolClosed" className="cursor-pointer text-sm">Pool closed / session cancelled</Label>
          </div>
          {form.poolClosed && (
            <div>
              <Label>Closure reason</Label>
              <Input className="mt-1 rounded-sm" value={form.closureReason}
                onChange={e => setForm(f => ({ ...f, closureReason: e.target.value }))} />
            </div>
          )}
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : session ? "Save changes" : "Log session"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SurveillanceDialog({
  open, onClose, check, sites, onSaved,
}: {
  open: boolean; onClose: () => void;
  check?: SurveillanceCheck | null;
  sites: { id: number; name: string }[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toTimeString().slice(0, 5);
  const blank = {
    siteId: "", checkDate: today, checkTime: now, batherCount: "",
    scanCompleted: true, observations: "", checkedBy: "", result: "pass",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(check ? {
    siteId: check.siteId ? String(check.siteId) : "",
    checkDate: check.checkDate, checkTime: check.checkTime ?? "",
    batherCount: check.batherCount != null ? String(check.batherCount) : "",
    scanCompleted: check.scanCompleted, observations: check.observations ?? "",
    checkedBy: check.checkedBy ?? "", result: check.result,
  } : blank);

  const handleSave = async () => {
    if (!form.checkDate) return toast({ title: "Date is required", variant: "destructive" });
    setSaving(true);
    try {
      const body = {
        siteId: form.siteId ? parseInt(form.siteId, 10) : null,
        checkDate: form.checkDate, checkTime: form.checkTime || null,
        batherCount: form.batherCount ? parseInt(form.batherCount, 10) : null,
        scanCompleted: form.scanCompleted,
        observations: form.observations.trim() || null,
        checkedBy: form.checkedBy.trim() || null,
        result: form.scanCompleted ? "pass" : "attention_required",
      };
      if (check) {
        await apiFetch(`/swim-track/surveillance/${check.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/swim-track/surveillance", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: check ? "Check updated" : "Surveillance check logged" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{check ? "Edit Surveillance Check" : "Log Surveillance Check"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.checkDate}
                onChange={e => setForm(f => ({ ...f, checkDate: e.target.value }))} />
            </div>
            <div>
              <Label>Time</Label>
              <Input type="time" className="mt-1 rounded-sm" value={form.checkTime}
                onChange={e => setForm(f => ({ ...f, checkTime: e.target.value }))} />
            </div>
            {sites.length > 0 && (
              <div className="col-span-2">
                <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
                <Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">— All sites —</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label>Bather count <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" min="0" className="mt-1 rounded-sm" value={form.batherCount}
                onChange={e => setForm(f => ({ ...f, batherCount: e.target.value }))} />
            </div>
            <div>
              <Label>Checked by <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.checkedBy}
                onChange={e => setForm(f => ({ ...f, checkedBy: e.target.value }))} placeholder="Staff name" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="scanDone" checked={form.scanCompleted}
              onChange={e => setForm(f => ({ ...f, scanCompleted: e.target.checked }))} className="rounded" />
            <Label htmlFor="scanDone" className="cursor-pointer text-sm">Full pool scan completed</Label>
          </div>
          <div>
            <Label>Observations <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={3} value={form.observations}
              onChange={e => setForm(f => ({ ...f, observations: e.target.value }))}
              placeholder="Anything to note during this surveillance check…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : check ? "Save changes" : "Log check"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FirstAidDialog({
  open, onClose, check, sites, onSaved,
}: {
  open: boolean; onClose: () => void;
  check?: FirstAidCheck | null;
  sites: { id: number; name: string }[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const blankItems = Object.fromEntries(FIRST_AID_ITEMS.map(i => [i.key, true]));
  const blank = { siteId: "", checkDate: today, checkedBy: "", defectsFound: "", notes: "", ...blankItems };
  const [form, setForm] = useState<Record<string, any>>(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(check ? {
    siteId: check.siteId ? String(check.siteId) : "",
    checkDate: check.checkDate, checkedBy: check.checkedBy ?? "",
    defectsFound: check.defectsFound ?? "", notes: check.notes ?? "",
    aedOk: check.aedOk, firstAidKitOk: check.firstAidKitOk,
    rescuePoleOk: check.rescuePoleOk, throwBagOk: check.throwBagOk,
    spineBoardOk: check.spineBoardOk, ringBuoyOk: check.ringBuoyOk, oxygenKitOk: check.oxygenKitOk,
  } : blank);

  const handleSave = async () => {
    if (!form.checkDate) return toast({ title: "Date is required", variant: "destructive" });
    setSaving(true);
    try {
      const body = {
        siteId: form.siteId ? parseInt(form.siteId, 10) : null,
        checkDate: form.checkDate, checkedBy: form.checkedBy.trim() || null,
        defectsFound: form.defectsFound.trim() || null, notes: form.notes.trim() || null,
        ...Object.fromEntries(FIRST_AID_ITEMS.map(i => [i.key, form[i.key]])),
      };
      if (check) {
        await apiFetch(`/swim-track/first-aid/${check.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/swim-track/first-aid", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: check ? "Check updated" : "First-aid check saved" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{check ? "Edit First-Aid Check" : "First-Aid Readiness Check"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.checkDate}
                onChange={e => setForm(f => ({ ...f, checkDate: e.target.value }))} />
            </div>
            <div>
              <Label>Checked by <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.checkedBy}
                onChange={e => setForm(f => ({ ...f, checkedBy: e.target.value }))} />
            </div>
            {sites.length > 0 && (
              <div className="col-span-2">
                <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
                <Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">— All sites —</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">Equipment checklist</Label>
            {FIRST_AID_ITEMS.map(item => (
              <div key={item.key} className="flex items-center gap-2">
                <input type="checkbox" id={item.key} checked={!!form[item.key]}
                  onChange={e => setForm(f => ({ ...f, [item.key]: e.target.checked }))} className="rounded" />
                <label htmlFor={item.key} className={`text-sm cursor-pointer ${!form[item.key] ? "text-destructive font-medium" : ""}`}>
                  {item.label}
                </label>
                {!form[item.key] && <XCircle className="w-3.5 h-3.5 text-destructive ml-auto" />}
              </div>
            ))}
          </div>
          <div>
            <Label>Defects / actions required <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.defectsFound}
              onChange={e => setForm(f => ({ ...f, defectsFound: e.target.value }))}
              placeholder="List any items that need repair or replacement…" />
          </div>
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : check ? "Save changes" : "Save check"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IncidentDialog({
  open, onClose, incident, sites, onSaved,
}: {
  open: boolean; onClose: () => void;
  incident?: Incident | null;
  sites: { id: number; name: string }[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    siteId: "", incidentDate: today, incidentTime: "", incidentType: "near_miss", severity: "low",
    personsInvolved: "", description: "", actionTaken: "", reportedTo: "",
    reportedDate: "", outcome: "", notes: "",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(incident ? {
    siteId: incident.siteId ? String(incident.siteId) : "",
    incidentDate: incident.incidentDate, incidentTime: incident.incidentTime ?? "",
    incidentType: incident.incidentType, severity: incident.severity,
    personsInvolved: incident.personsInvolved ?? "",
    description: incident.description, actionTaken: incident.actionTaken ?? "",
    reportedTo: incident.reportedTo ?? "", reportedDate: incident.reportedDate ?? "",
    outcome: incident.outcome ?? "", notes: incident.notes ?? "",
  } : blank);

  const handleSave = async () => {
    if (!form.incidentDate) return toast({ title: "Date is required", variant: "destructive" });
    if (!form.description.trim()) return toast({ title: "Description is required", variant: "destructive" });
    setSaving(true);
    try {
      const body = {
        siteId: form.siteId ? parseInt(form.siteId, 10) : null,
        incidentDate: form.incidentDate, incidentTime: form.incidentTime || null,
        incidentType: form.incidentType, severity: form.severity,
        personsInvolved: form.personsInvolved.trim() || null,
        description: form.description.trim(),
        actionTaken: form.actionTaken.trim() || null,
        reportedTo: form.reportedTo.trim() || null,
        reportedDate: form.reportedDate || null,
        outcome: form.outcome.trim() || null, notes: form.notes.trim() || null,
      };
      if (incident) {
        await apiFetch(`/swim-track/incidents/${incident.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/swim-track/incidents", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: incident ? "Incident updated" : "Incident logged" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{incident ? "Edit Incident" : "Log Incident / Near Miss"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Incident date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.incidentDate}
                onChange={e => setForm(f => ({ ...f, incidentDate: e.target.value }))} />
            </div>
            <div>
              <Label>Time <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="time" className="mt-1 rounded-sm" value={form.incidentTime}
                onChange={e => setForm(f => ({ ...f, incidentTime: e.target.value }))} />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={form.incidentType} onValueChange={v => setForm(f => ({ ...f, incidentType: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(INCIDENT_TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Severity</Label>
              <Select value={form.severity} onValueChange={v => setForm(f => ({ ...f, severity: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SEVERITY_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {sites.length > 0 && (
              <div className="col-span-2">
                <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
                <Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">— All sites —</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div>
            <Label>Persons involved <span className="text-muted-foreground text-xs">optional — do not record names of members of public</span></Label>
            <Input className="mt-1 rounded-sm" value={form.personsInvolved}
              onChange={e => setForm(f => ({ ...f, personsInvolved: e.target.value }))}
              placeholder="e.g. 1 adult male bather, 2 staff members" />
          </div>
          <div>
            <Label>Description *</Label>
            <Textarea className="mt-1 rounded-sm" rows={3} value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Describe what happened…" />
          </div>
          <div>
            <Label>Action taken <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.actionTaken}
              onChange={e => setForm(f => ({ ...f, actionTaken: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Reported to <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.reportedTo}
                onChange={e => setForm(f => ({ ...f, reportedTo: e.target.value }))} placeholder="Name / authority" />
            </div>
            <div>
              <Label>Date reported <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.reportedDate}
                onChange={e => setForm(f => ({ ...f, reportedDate: e.target.value }))} />
            </div>
          </div>
          <div>
            <Label>Outcome <span className="text-muted-foreground text-xs">leave blank if still open</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.outcome}
              onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}
              placeholder="Resolution / outcome…" />
          </div>
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className={form.severity === "critical" ? "bg-destructive hover:bg-destructive/90" : ""}>
            {saving ? "Saving…" : incident ? "Save changes" : "Log incident"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = "sessions" | "surveillance" | "first-aid" | "incidents";

export default function SwimTrackPage() {
  const { user } = useAuth();
  const canAdmin = useCanAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("sessions");
  const [search, setSearch] = useState("");
  const [sessionDialog, setSessionDialog] = useState(false);
  const [editSession, setEditSession] = useState<SwimSession | null>(null);
  const [surveillanceDialog, setSurveillanceDialog] = useState(false);
  const [editSurveillance, setEditSurveillance] = useState<SurveillanceCheck | null>(null);
  const [firstAidDialog, setFirstAidDialog] = useState(false);
  const [editFirstAid, setEditFirstAid] = useState<FirstAidCheck | null>(null);
  const [incidentDialog, setIncidentDialog] = useState(false);
  const [editIncident, setEditIncident] = useState<Incident | null>(null);
  const [deleteId, setDeleteId] = useState<{ type: string; id: number } | null>(null);

  const { data: sites = [] } = useQuery({
    queryKey: ["sites"],
    queryFn: () => apiFetch<{ id: number; name: string }[]>("/sites"),
  });
  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ["swim-status"],
    queryFn: () => apiFetch<StatusData>("/swim-track/status"),
    refetchInterval: 60_000,
  });
  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ["swim-sessions"],
    queryFn: () => apiFetch<SwimSession[]>("/swim-track/sessions"),
    enabled: activeTab === "sessions",
  });
  const { data: surveillance = [], isLoading: surveillanceLoading } = useQuery({
    queryKey: ["swim-surveillance"],
    queryFn: () => apiFetch<SurveillanceCheck[]>("/swim-track/surveillance"),
    enabled: activeTab === "surveillance",
  });
  const { data: firstAidChecks = [], isLoading: firstAidLoading } = useQuery({
    queryKey: ["swim-first-aid"],
    queryFn: () => apiFetch<FirstAidCheck[]>("/swim-track/first-aid"),
    enabled: activeTab === "first-aid",
  });
  const { data: incidents = [], isLoading: incidentsLoading } = useQuery({
    queryKey: ["swim-incidents"],
    queryFn: () => apiFetch<Incident[]>("/swim-track/incidents"),
    enabled: activeTab === "incidents",
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["swim-sessions"] });
    queryClient.invalidateQueries({ queryKey: ["swim-surveillance"] });
    queryClient.invalidateQueries({ queryKey: ["swim-first-aid"] });
    queryClient.invalidateQueries({ queryKey: ["swim-incidents"] });
    queryClient.invalidateQueries({ queryKey: ["swim-status"] });
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await apiFetch(`/swim-track/${deleteId.type}/${deleteId.id}`, { method: "DELETE" });
      toast({ title: "Record deleted" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally { setDeleteId(null); }
  };

  const q = search.toLowerCase();
  const filteredSessions = useMemo(() =>
    sessions.filter(s =>
      (s.lifeguardName ?? "").toLowerCase().includes(q) ||
      (s.siteName ?? "").toLowerCase().includes(q) ||
      SESSION_TYPE_LABELS[s.sessionType]?.toLowerCase().includes(q)
    ), [sessions, q]);

  const filteredSurveillance = useMemo(() =>
    surveillance.filter(s =>
      (s.checkedBy ?? "").toLowerCase().includes(q) ||
      (s.siteName ?? "").toLowerCase().includes(q)
    ), [surveillance, q]);

  const filteredFirstAid = useMemo(() =>
    firstAidChecks.filter(f =>
      (f.checkedBy ?? "").toLowerCase().includes(q) ||
      (f.siteName ?? "").toLowerCase().includes(q)
    ), [firstAidChecks, q]);

  const filteredIncidents = useMemo(() =>
    incidents.filter(i =>
      i.description.toLowerCase().includes(q) ||
      (i.siteName ?? "").toLowerCase().includes(q) ||
      INCIDENT_TYPE_LABELS[i.incidentType]?.toLowerCase().includes(q)
    ), [incidents, q]);

  const TABS: { key: Tab; label: string; icon: any; count?: number }[] = [
    { key: "sessions",     label: "Sessions",     icon: Waves,       count: status?.sessionsToday || undefined },
    { key: "surveillance", label: "Surveillance",  icon: Activity,    count: status?.surveillanceToday || undefined },
    { key: "first-aid",    label: "First Aid",     icon: HeartPulse,  count: status?.firstAidActionRequired || undefined },
    { key: "incidents",    label: "Incidents",     icon: ShieldAlert, count: status?.openIncidents || undefined },
  ];

  const today = new Date().toISOString().split("T")[0];
  const firstAidOverdue = status?.lastFirstAidCheck
    ? new Date(status.lastFirstAidCheck) < new Date(Date.now() - 30 * 86400000)
    : true;

  return (
    <AppLayout title="SwimTrack">
      <div className="space-y-6">

        {/* ── Status strip ─────────────────────────────────────────────── */}
        {status && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              {
                label: "Sessions today",
                value: String(status.sessionsToday),
                sub: status.poolsClosedToday > 0 ? `${status.poolsClosedToday} closed` : "All open",
                icon: Waves,
                cls: "text-primary",
              },
              {
                label: "Surveillance checks",
                value: String(status.surveillanceToday),
                sub: "today",
                icon: Activity,
                cls: "text-blue-500",
              },
              {
                label: "First-aid checks",
                value: String(status.firstAidLast30d),
                sub: firstAidOverdue ? "⚠ overdue (30d)" : "last 30 days",
                icon: HeartPulse,
                cls: firstAidOverdue ? "text-destructive" : "text-green-500",
              },
              {
                label: "Open incidents",
                value: String(status.openIncidents),
                sub: "no outcome recorded",
                icon: ShieldAlert,
                cls: status.openIncidents > 0 ? "text-destructive" : "text-muted-foreground",
              },
            ].map(card => (
              <div key={card.label} className="border rounded-sm p-3 space-y-1 bg-card">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <card.icon className={`w-3.5 h-3.5 ${card.cls}`} />
                  {card.label}
                </div>
                <div className="text-2xl font-semibold tabular-nums">{card.value}</div>
                <div className="text-xs text-muted-foreground">{card.sub}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Tab bar + toolbar ────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex gap-1 border-b flex-1 overflow-x-auto">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === t.key
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className="ml-0.5 text-xs bg-primary/10 text-primary rounded-full px-1.5 py-0.5 tabular-nums">
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input className="pl-7 h-8 text-sm rounded-sm w-40" placeholder="Search…"
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {activeTab === "sessions" && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8"
                onClick={() => { setEditSession(null); setSessionDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log session
              </Button>
            )}
            {activeTab === "surveillance" && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8"
                onClick={() => { setEditSurveillance(null); setSurveillanceDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log check
              </Button>
            )}
            {activeTab === "first-aid" && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8"
                onClick={() => { setEditFirstAid(null); setFirstAidDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Check equipment
              </Button>
            )}
            {activeTab === "incidents" && (
              <Button size="sm" variant="destructive" className="rounded-sm gap-1.5 h-8"
                onClick={() => { setEditIncident(null); setIncidentDialog(true); }}>
                <ShieldAlert className="w-3.5 h-3.5" /> Log incident
              </Button>
            )}
          </div>
        </div>

        {/* ── Sessions tab ──────────────────────────────────────────────── */}
        {activeTab === "sessions" && (
          <>
            {sessionsLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading sessions…</div>
            ) : filteredSessions.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <Waves className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No sessions logged yet.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5"
                  onClick={() => { setEditSession(null); setSessionDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Log first session
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-xs">
                      <th className="text-left font-medium py-2 pr-4">Date</th>
                      <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Type</th>
                      <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Site</th>
                      <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Lifeguard</th>
                      <th className="text-left font-medium py-2 pr-4 hidden lg:table-cell">Times</th>
                      <th className="text-right font-medium py-2 pr-4 hidden md:table-cell">Peak bathers</th>
                      <th className="text-left font-medium py-2 pr-4">Pre-session</th>
                      <th className="text-left font-medium py-2 pr-4">Status</th>
                      <th className="w-14" />
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSessions.map(s => (
                      <tr key={s.id} className={`border-b last:border-0 ${s.poolClosed ? "bg-red-50 dark:bg-red-900/10" : ""}`}>
                        <td className="py-2 pr-4 tabular-nums font-medium">{s.sessionDate}</td>
                        <td className="py-2 pr-4 text-muted-foreground hidden sm:table-cell">
                          {SESSION_TYPE_LABELS[s.sessionType] ?? s.sessionType}
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{s.siteName ?? "—"}</td>
                        <td className="py-2 pr-4 hidden sm:table-cell">{s.lifeguardName ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-4 text-muted-foreground tabular-nums hidden lg:table-cell">
                          {s.openTime ?? "—"}{s.closeTime ? ` – ${s.closeTime}` : ""}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums hidden md:table-cell">
                          {s.batherCountPeak != null
                            ? <>{s.batherCountPeak}{s.maxBathers ? <span className="text-muted-foreground">/{s.maxBathers}</span> : null}</>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-4">
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                            s.preSessionResult === "pass" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
                            s.preSessionResult === "advisory" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" :
                            "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                          }`}>
                            {s.preSessionResult === "pass" ? "Pass" : s.preSessionResult === "advisory" ? "Advisory" : "Fail"}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          {s.poolClosed
                            ? <span className="text-xs text-destructive font-medium flex items-center gap-1"><XCircle className="w-3 h-3" />Closed</span>
                            : <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Open</span>}
                        </td>
                        <td className="py-2 px-2">
                          <CheckPhotoUploader entityType="swim_session" entityId={s.id} compact />
                        </td>
                        <td className="py-2 text-right">
                          <Button size="icon" variant="ghost" className="h-7 w-7"
                            onClick={() => { setEditSession(s); setSessionDialog(true); }}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {canAdmin && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => setDeleteId({ type: "sessions", id: s.id })}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── Surveillance tab ───────────────────────────────────────────── */}
        {activeTab === "surveillance" && (
          <>
            <div className="text-xs text-muted-foreground bg-muted/40 rounded-sm px-3 py-2 flex items-start gap-2">
              <Activity className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>RLSS UK recommends lifeguards perform a full pool scan and log a surveillance check every 15–20 minutes. Record each check during open sessions.</span>
            </div>
            {surveillanceLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading checks…</div>
            ) : filteredSurveillance.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <Activity className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No surveillance checks recorded yet.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5"
                  onClick={() => { setEditSurveillance(null); setSurveillanceDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Log first check
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-xs">
                      <th className="text-left font-medium py-2 pr-4">Date</th>
                      <th className="text-left font-medium py-2 pr-4">Time</th>
                      <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Site</th>
                      <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Checked by</th>
                      <th className="text-right font-medium py-2 pr-4 hidden sm:table-cell">Bathers</th>
                      <th className="text-left font-medium py-2 pr-4">Scan done</th>
                      <th className="text-left font-medium py-2 pr-4 hidden lg:table-cell">Observations</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSurveillance.map(c => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 tabular-nums">{c.checkDate}</td>
                        <td className="py-2 pr-4 tabular-nums">{c.checkTime ?? "—"}</td>
                        <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{c.siteName ?? "—"}</td>
                        <td className="py-2 pr-4 hidden sm:table-cell">{c.checkedBy ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">
                          {c.batherCount != null ? c.batherCount : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-4">
                          {c.scanCompleted
                            ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                            : <XCircle className="w-4 h-4 text-destructive" />}
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground text-xs max-w-xs truncate hidden lg:table-cell">
                          {c.observations ?? "—"}
                        </td>
                        <td className="py-2 text-right">
                          <Button size="icon" variant="ghost" className="h-7 w-7"
                            onClick={() => { setEditSurveillance(c); setSurveillanceDialog(true); }}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {canAdmin && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => setDeleteId({ type: "surveillance", id: c.id })}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── First Aid tab ──────────────────────────────────────────────── */}
        {activeTab === "first-aid" && (
          <>
            <div className="text-xs text-muted-foreground bg-muted/40 rounded-sm px-3 py-2 flex items-start gap-2">
              <HeartPulse className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>RLSS UK and HSG179 recommend checking all rescue and first-aid equipment at least monthly and before each pool session. Records must be retained for audit.</span>
            </div>
            {firstAidOverdue && (
              <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-sm px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>No first-aid equipment check in the last 30 days — a check is overdue.</span>
                <Button size="sm" variant="outline" className="ml-auto rounded-sm h-7 border-amber-300 text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-700 dark:hover:bg-amber-900/40"
                  onClick={() => { setEditFirstAid(null); setFirstAidDialog(true); }}>
                  Check now
                </Button>
              </div>
            )}
            {firstAidLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading checks…</div>
            ) : filteredFirstAid.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <HeartPulse className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No first-aid checks recorded yet.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5"
                  onClick={() => { setEditFirstAid(null); setFirstAidDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> First check
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-xs">
                      <th className="text-left font-medium py-2 pr-4">Date</th>
                      <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Site</th>
                      <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Checked by</th>
                      {FIRST_AID_ITEMS.map(i => (
                        <th key={i.key} className="text-center font-medium py-2 px-1 hidden lg:table-cell text-xs max-w-[60px]">
                          {i.label.split(" ")[0]}
                        </th>
                      ))}
                      <th className="text-left font-medium py-2 pr-4">Result</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFirstAid.map(f => {
                      const items = FIRST_AID_ITEMS.map(i => ({ ...i, ok: !!(f as any)[i.key] }));
                      const failCount = items.filter(i => !i.ok).length;
                      return (
                        <tr key={f.id} className={`border-b last:border-0 ${failCount > 0 ? "bg-amber-50 dark:bg-amber-900/10" : ""}`}>
                          <td className="py-2 pr-4 tabular-nums">{f.checkDate}</td>
                          <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{f.siteName ?? "—"}</td>
                          <td className="py-2 pr-4 hidden sm:table-cell">{f.checkedBy ?? <span className="text-muted-foreground">—</span>}</td>
                          {items.map(i => (
                            <td key={i.key} className="py-2 px-1 text-center hidden lg:table-cell">
                              {i.ok
                                ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 mx-auto" />
                                : <XCircle className="w-3.5 h-3.5 text-destructive mx-auto" />}
                            </td>
                          ))}
                          <td className="py-2 pr-4">
                            {f.result === "pass"
                              ? <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-1.5 py-0.5 rounded-full flex items-center gap-1 w-fit">
                                  <CheckCircle2 className="w-3 h-3" /> Pass
                                </span>
                              : <span className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 px-1.5 py-0.5 rounded-full flex items-center gap-1 w-fit">
                                  <AlertTriangle className="w-3 h-3" /> Action required
                                </span>}
                          </td>
                          <td className="py-2 text-right">
                            <Button size="icon" variant="ghost" className="h-7 w-7"
                              onClick={() => { setEditFirstAid(f); setFirstAidDialog(true); }}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            {canAdmin && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                                onClick={() => setDeleteId({ type: "first-aid", id: f.id })}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── Incidents tab ──────────────────────────────────────────────── */}
        {activeTab === "incidents" && (
          <>
            {incidentsLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading incidents…</div>
            ) : filteredIncidents.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <ShieldAlert className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No incidents recorded.</p>
                <p className="text-xs text-muted-foreground mt-1">Record near misses and incidents as they occur.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5"
                  onClick={() => { setEditIncident(null); setIncidentDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Log incident
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-xs">
                      <th className="text-left font-medium py-2 pr-4">Date</th>
                      <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Type</th>
                      <th className="text-left font-medium py-2 pr-4">Severity</th>
                      <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Site</th>
                      <th className="text-left font-medium py-2 pr-4">Description</th>
                      <th className="text-left font-medium py-2 pr-4 hidden lg:table-cell">Action taken</th>
                      <th className="text-left font-medium py-2 pr-4">Outcome</th>
                      <th className="w-14" />
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredIncidents.map(i => (
                      <tr key={i.id} className={`border-b last:border-0 ${i.severity === "critical" || i.severity === "high" ? "bg-red-50 dark:bg-red-900/10" : ""}`}>
                        <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                          {i.incidentDate}
                          {i.incidentTime && <span className="text-muted-foreground text-xs ml-1">{i.incidentTime}</span>}
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground hidden sm:table-cell">
                          {INCIDENT_TYPE_LABELS[i.incidentType] ?? i.incidentType}
                        </td>
                        <td className="py-2 pr-4">
                          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                            i.severity === "critical" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                            i.severity === "high" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" :
                            i.severity === "medium" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" :
                            "bg-muted text-muted-foreground"
                          }`}>
                            {SEVERITY_LABELS[i.severity] ?? i.severity}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{i.siteName ?? "—"}</td>
                        <td className="py-2 pr-4 max-w-xs truncate">{i.description}</td>
                        <td className="py-2 pr-4 text-muted-foreground text-xs max-w-[160px] truncate hidden lg:table-cell">
                          {i.actionTaken ?? "—"}
                        </td>
                        <td className="py-2 pr-4">
                          {i.outcome
                            ? <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-1.5 py-0.5 rounded-full">Resolved</span>
                            : <span className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 px-1.5 py-0.5 rounded-full">Open</span>}
                        </td>
                        <td className="py-2 px-2">
                          <CheckPhotoUploader entityType="swim_incident" entityId={i.id} compact />
                        </td>
                        <td className="py-2 text-right">
                          <Button size="icon" variant="ghost" className="h-7 w-7"
                            onClick={() => { setEditIncident(i); setIncidentDialog(true); }}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {canAdmin && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => setDeleteId({ type: "incidents", id: i.id })}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

      </div>

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      <SessionDialog open={sessionDialog} onClose={() => { setSessionDialog(false); setEditSession(null); }}
        session={editSession} sites={sites} onSaved={invalidate} />

      <SurveillanceDialog open={surveillanceDialog} onClose={() => { setSurveillanceDialog(false); setEditSurveillance(null); }}
        check={editSurveillance} sites={sites} onSaved={invalidate} />

      <FirstAidDialog open={firstAidDialog} onClose={() => { setFirstAidDialog(false); setEditFirstAid(null); }}
        check={editFirstAid} sites={sites} onSaved={invalidate} />

      <IncidentDialog open={incidentDialog} onClose={() => { setIncidentDialog(false); setEditIncident(null); }}
        incident={editIncident} sites={sites} onSaved={invalidate} />

      <AlertDialog open={!!deleteId} onOpenChange={v => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
