import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "@e965/xlsx";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Users, Plus, Pencil, Trash2, Loader2, Search, UserCheck, UserX, Upload, FileSpreadsheet, X, Printer } from "lucide-react";
import { cn } from "@/lib/utils";
import { printHtmlDocument } from "@/lib/download";

interface StaffMember {
  id: number;
  client_id: number;
  site_id: number | null;
  name: string;
  external_payroll_id: string | null;
  job_title: string | null;
  department: string | null;
  email: string | null;
  active: boolean;
  site_name: string | null;
  created_at: string;
  has_pin?: boolean;
  pin_set?: boolean;
}

interface Site { id: number; name: string; }

const EMPTY_FORM = { name: "", externalPayrollId: "", jobTitle: "", department: "", email: "", siteId: "none", active: true };

function StaffDialog({
  open, onClose, onSaved, sites, editing,
}: {
  open: boolean; onClose: () => void; onSaved: () => void;
  sites: Site[]; editing: StaffMember | null;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name,
        externalPayrollId: editing.external_payroll_id ?? "",
        jobTitle: editing.job_title ?? "",
        department: editing.department ?? "",
        email: editing.email ?? "",
        siteId: editing.site_id ? String(editing.site_id) : "none",
        active: editing.active,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [editing, open]);

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        externalPayrollId: form.externalPayrollId.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
        department: form.department.trim() || null,
        email: form.email.trim() || null,
        siteId: form.siteId !== "none" ? Number(form.siteId) : null,
        active: form.active,
      };
      const res = await apiFetch(
        editing ? `/staff-roster/${editing.id}` : "/staff-roster",
        { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      if (!res.ok) throw new Error("Save failed");
      toast({ title: editing ? "Staff member updated" : "Staff member added" });
      onSaved();
      onClose();
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Staff Member" : "Add Staff Member"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Name <span className="text-destructive">*</span></Label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Full name" />
          </div>
          <div className="space-y-1.5">
            <Label>Payroll / workforce identifier <span className="text-muted-foreground text-xs">(recommended)</span></Label>
            <Input value={form.externalPayrollId} onChange={e => setForm(f => ({ ...f, externalPayrollId: e.target.value }))} placeholder="e.g. EMP-1042" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Job Title</Label>
              <Input value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} placeholder="e.g. Chef" />
            </div>
            <div className="space-y-1.5">
              <Label>Department</Label>
              <Input value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} placeholder="e.g. Kitchen" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Email <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="staff@example.com" />
          </div>
          {sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Select value={form.siteId} onValueChange={v => setForm(f => ({ ...f, siteId: v }))}>
                <SelectTrigger><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">All sites</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {editing && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, active: !f.active }))}
                className={cn(
                  "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                  form.active ? "bg-primary" : "bg-muted",
                )}
              >
                <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform", form.active ? "translate-x-4" : "translate-x-1")} />
              </button>
              <Label className="cursor-pointer" onClick={() => setForm(f => ({ ...f, active: !f.active }))}>
                {form.active ? "Active" : "Inactive"}
              </Label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={!form.name.trim() || saving}>
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
            {editing ? "Save Changes" : "Add Staff Member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ParsedStaff {
  externalPayrollId: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
  email: string | null;
}

function parseExcel(file: File): Promise<ParsedStaff[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: "" });

        // Normalise header names
        const normalise = (k: string) => k.toLowerCase().replace(/[\s_-]/g, "");
        const find = (row: Record<string, any>, ...keys: string[]) => {
          const entry = Object.entries(row).find(([k]) => keys.includes(normalise(k)));
          return entry ? String(entry[1]).trim() || null : null;
        };

        const members: ParsedStaff[] = rows
          .map(row => ({
            externalPayrollId: find(row, "payrollid", "employeeid", "staffid", "workforceid", "identifier") ?? "",
            name:       find(row, "name", "fullname", "staffname", "employeename") ?? "",
            jobTitle:   find(row, "jobtitle", "title", "role", "position", "job"),
            department: find(row, "department", "dept", "team", "area", "division"),
            email:      find(row, "email", "emailaddress", "mail"),
          }))
          .filter(m => m.name.length > 0 || m.externalPayrollId.length > 0);

        resolve(members);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}

function parsePasteText(text: string): ParsedStaff[] {
  return text.split("\n")
    .map(l => l.trim()).filter(Boolean)
    .map(line => {
      const [externalPayrollId, name, jobTitle, department, email] = line.split(",").map(s => s.trim());
      return { externalPayrollId: externalPayrollId || "", name: name || "", jobTitle: jobTitle || null, department: department || null, email: email || null };
    })
    .filter(m => m.name);
}

function BulkImportDialog({ open, onClose, onImported, sites }: { open: boolean; onClose: () => void; onImported: () => void; sites: Site[] }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"excel" | "paste">("excel");
  const [text, setText] = useState("");
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ParsedStaff[]>([]);
  const [siteId, setSiteId] = useState("none");
  const [importing, setImporting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [reconciliation, setReconciliation] = useState<{ total: number; created: number; updated: number; reactivated: number; unchanged: number; deactivated: number; matchedByEmail: number; matchedByName: number } | null>(null);

  function reset() {
    setText(""); setExcelFile(null); setPreview([]);
    setSiteId("none"); setMode("excel"); setReconciliation(null);
  }

  async function handleFileChange(file: File) {
    setExcelFile(file);
    setParsing(true);
    try {
      const members = await parseExcel(file);
      setPreview(members);
      setReconciliation(null);
    } catch {
      toast({ title: "Could not read file", description: "Make sure it is a valid .xlsx or .xls file.", variant: "destructive" });
      setExcelFile(null);
    } finally {
      setParsing(false);
    }
  }

  const members: ParsedStaff[] = mode === "excel" ? preview : parsePasteText(text);
  const canImport = members.length > 0 && members.every(member => member.externalPayrollId.trim() && member.name.trim()) && !importing;

  async function handleImport() {
    if (!members.length) return;
    setImporting(true);
    try {
      const body = {
        rows: members.map(m => ({ ...m, siteId: siteId !== "none" ? Number(siteId) : null })),
        siteId: siteId !== "none" ? Number(siteId) : null,
        preview: !reconciliation,
      };
      const res = await apiFetch("/staff-roster/reconcile", { method: "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Roster reconciliation failed");
      if (!reconciliation) {
        setReconciliation(data.summary);
        return;
      }
      toast({ title: "Monthly roster updated", description: `${data.summary.created} added, ${data.summary.updated + data.summary.reactivated} updated, ${data.summary.deactivated} made inactive.` });
      onImported();
      reset();
      onClose();
    } catch (error) {
      toast({ title: "Roster update failed", description: error instanceof Error ? error.message : "Please check the file and try again.", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !importing) { reset(); onClose(); } }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="w-4 h-4" /> Replace monthly staff roster</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Mode tabs */}
          <div className="flex rounded-lg border overflow-hidden text-sm">
            <button
              className={cn("flex-1 py-2 font-medium transition-colors flex items-center justify-center gap-1.5",
                mode === "excel" ? "bg-primary text-primary-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground")}
              onClick={() => setMode("excel")}
            >
              <FileSpreadsheet className="w-4 h-4" /> Upload Excel / CSV
            </button>
            <button
              className={cn("flex-1 py-2 font-medium transition-colors",
                mode === "paste" ? "bg-primary text-primary-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground")}
              onClick={() => setMode("paste")}
            >
              Paste a list
            </button>
          </div>

          {mode === "excel" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                 Upload the complete current roster as Excel or CSV. Required columns: <strong>Payroll ID</strong> and <strong>Name</strong>. Optional columns: Job Title, Department and Email.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileChange(f); }}
              />
              {!excelFile ? (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed rounded-lg p-6 text-center hover:border-primary/50 hover:bg-muted/20 transition-colors"
                >
                  <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-50" />
                  <p className="text-sm font-medium text-muted-foreground">Click to choose an Excel or CSV file</p>
                </button>
              ) : (
                <div className="flex items-center gap-3 p-3 border rounded-lg bg-muted/20">
                  <FileSpreadsheet className="w-5 h-5 text-green-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{excelFile.name}</p>
                    {parsing ? (
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Reading…</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">{preview.length} staff member{preview.length === 1 ? "" : "s"} found</p>
                    )}
                  </div>
                  <button onClick={() => { setExcelFile(null); setPreview([]); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Preview table */}
              {preview.length > 0 && (
                <div className="border rounded-lg overflow-hidden max-h-52 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
                         <th className="text-left px-3 py-2 font-medium text-muted-foreground">Payroll ID</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Job Title</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Department</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {preview.slice(0, 50).map((m, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5 font-medium">{m.name}</td>
                           <td className="px-3 py-1.5 text-muted-foreground">{m.externalPayrollId || "Missing"}</td>
                          <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">{m.jobTitle ?? "—"}</td>
                          <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">{m.department ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.length > 50 && <p className="text-xs text-center text-muted-foreground py-2">…and {preview.length - 50} more</p>}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                One staff member per line: payroll ID, name, then optional job title, department and email.
              </p>
              <div className="bg-muted/40 rounded-md p-3 text-xs text-muted-foreground font-mono space-y-0.5">
                <p>EMP-1001, John Smith</p>
                <p>EMP-1002, Jane Doe, Chef, Kitchen</p>
                <p>EMP-1003, Bob Jones, Manager, Front of House, bob@example.com</p>
              </div>
              <textarea
                className="w-full border rounded-md p-3 text-sm font-mono resize-y min-h-[120px] focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={"EMP-1001, John Smith\nEMP-1002, Jane Doe, Chef, Kitchen\n..."}
                value={text}
                onChange={e => { setText(e.target.value); setReconciliation(null); }}
              />
            </div>
          )}

          {sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Assign all to site <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Select value={siteId} onValueChange={value => { setSiteId(value); setReconciliation(null); }}>
                <SelectTrigger><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">All sites</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            This is a complete replacement for {siteId === "none" ? "the whole current roster" : "the selected site's current roster"}. Staff missing from the file will be made inactive, never deleted. Their training and compliance history will remain.
          </div>
          {members.some(member => !member.externalPayrollId.trim() || !member.name.trim()) && <p className="text-sm text-destructive">Every row needs both a payroll identifier and a name.</p>}
          {reconciliation && <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-4">
            <div><strong>{reconciliation.created}</strong><br /><span className="text-muted-foreground">New</span></div>
            <div><strong>{reconciliation.updated}</strong><br /><span className="text-muted-foreground">Updated</span></div>
            <div><strong>{reconciliation.reactivated}</strong><br /><span className="text-muted-foreground">Reactivated</span></div>
            <div><strong>{reconciliation.deactivated}</strong><br /><span className="text-muted-foreground">Made inactive</span></div>
            {(reconciliation.matchedByEmail + reconciliation.matchedByName) > 0 && <p className="col-span-2 text-xs text-muted-foreground sm:col-span-4">{reconciliation.matchedByEmail + reconciliation.matchedByName} existing staff matched safely and will keep their history.</p>}
          </div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={importing}>Cancel</Button>
          <Button onClick={handleImport} disabled={!canImport}>
            {importing && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
            {reconciliation ? "Confirm monthly replacement" : `Preview ${members.length > 0 ? `${members.length} staff` : "roster"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function StaffRosterPage() {
  const { activeClientId, client, user } = useAuth();
  const { toast } = useToast();

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StaffMember | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pinStatus, setPinStatus] = useState<Record<number, boolean>>({});
  const [generatingKioskToken, setGeneratingKioskToken] = useState(false);
  const [kioskToken, setKioskToken] = useState<string | null>(null);
  const [enrollmentLinks, setEnrollmentLinks] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/staff-roster${showInactive ? "?includeInactive=true" : ""}`);
      if (res.ok) {
        const rows = await res.json();
        setStaff(rows);
        // The lightweight /staff endpoint intentionally exposes only PIN presence,
        // never the PIN itself. Keep this separate so the existing roster endpoint
        // (including inactive and reconciliation fields) remains unchanged.
        const pinResponse = await apiFetch("/staff");
        if (pinResponse.ok) {
          const activeRows = await pinResponse.json();
          setPinStatus(Object.fromEntries((activeRows as StaffMember[]).map(member => [
            member.id, member.has_pin === true || member.pin_set === true,
          ])));
        }
      }
    } finally {
      setLoading(false);
    }
  }, [activeClientId, showInactive]);

  useEffect(() => {
    if (!activeClientId) return;
    load();
    apiFetch("/sites").then(r => r.ok ? r.json() : []).then(setSites);
  }, [activeClientId, load]);

  async function generateKioskLink() {
    setGeneratingKioskToken(true);
    try {
      const response = await apiFetch("/staff/kiosk-token", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.kiosk_token !== "string") throw new Error(data.error || "Could not generate kiosk link");
      setKioskToken(data.kiosk_token);
      const base = `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/?$/, "/");
      // Keep the reusable bearer token out of URLs sent in referrers, server logs,
      // and browser history. The kiosk consumes it from the fragment and then
      // removes the fragment before making any API request.
      window.open(`${base}kiosk#kiosk_token=${encodeURIComponent(data.kiosk_token)}`, "_blank", "noopener,noreferrer");
      toast({ title: "Kiosk link opened", description: "Rotating the token invalidates any older kiosk links." });
    } catch (error) {
      toast({ title: "Could not generate kiosk link", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally { setGeneratingKioskToken(false); }
  }

  async function issuePinLink(member: StaffMember, reset: boolean) {
    if (reset && !window.confirm(`Reset ${member.name}'s PIN? Their current PIN will stop working immediately.`)) return;
    try {
      const response = await apiFetch(`/staff/${member.id}/${reset ? "reset-pin" : "pin-enrollment"}`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.enrollment_token !== "string") throw new Error(data.error || "Could not create setup link");
      const url = `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/?$/, "/") +
        `staff/set-pin#staff_id=${member.id}&enrollment_token=${encodeURIComponent(data.enrollment_token)}`;
      setEnrollmentLinks(prev => ({ ...prev, [member.id]: url }));
      await navigator.clipboard?.writeText(url);
      toast({ title: reset ? "PIN reset; setup link created" : "PIN setup link created", description: "The one-time link expires in 15 minutes and was copied when supported." });
    } catch (error) {
      toast({ title: "Could not create setup link", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/staff-roster/${deleteTarget.id}`, { method: "DELETE" });
      toast({ title: "Staff member removed" });
      setStaff(prev => prev.filter(s => s.id !== deleteTarget.id));
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  const filtered = staff.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) ||
      (s.job_title ?? "").toLowerCase().includes(q) ||
      (s.department ?? "").toLowerCase().includes(q);
  });

  const activeCount = staff.filter(s => s.active).length;

  // Printable roster — uses the standard printable-HTML window.print pattern.
  const esc = (v: string | null | undefined) =>
    String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const companyName = client?.name ?? "";
  const todayLabel = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  function handlePrintRoster() {
    // Print exactly what is currently shown (respects search + inactive toggle).
    const rows = filtered;
    if (rows.length === 0) {
      toast({ title: "Nothing to print", description: "No staff match the current view." });
      return;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Staff Roster — ${esc(companyName)}</title>
<style>
  body { font-family: Georgia, serif; color: #1a1a1a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }
  th, td { border: 1px solid #bbb; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f0ede2; font-weight: bold; }
  .footer { margin-top: 40px; font-size: 10.5px; color: #777; border-top: 1px solid #ccc; padding-top: 6px; }
  @media print { body { margin: 12mm; } }
</style></head><body>
<h1>Staff Roster</h1>
<div class="meta">${esc(companyName)} — ${rows.length} staff — generated ${esc(todayLabel)}</div>
<table>
<tr><th>Name</th><th>Job Title</th><th>Department</th><th>Site</th><th>Contact</th><th>Status</th></tr>
${rows.map(s => `<tr>
  <td>${esc(s.name)}</td>
  <td>${esc(s.job_title ?? "—")}</td>
  <td>${esc(s.department ?? "—")}</td>
  <td>${esc(s.site_name ?? "All sites")}</td>
  <td>${esc(s.email ?? "—")}</td>
  <td>${s.active ? "Active" : "Inactive"}</td>
</tr>`).join("")}
</table>
<div class="footer">${esc(companyName)} · Generated by ${esc(user?.name ?? "")} on ${esc(todayLabel)}</div>
</body></html>`;
    printHtmlDocument(html);
  }

  return (
    <AppLayout title="Staff Roster">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-2 bg-indigo-50 rounded-lg">
              <Users className="w-5 h-5 text-indigo-600" />
            </div>
            <h1 className="text-2xl font-display font-bold text-foreground">Staff Roster</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Manage your staff list — used for document acknowledgements and training records
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Button variant="outline" onClick={handlePrintRoster} className="gap-1.5">
            <Printer className="w-4 h-4" /> Print Roster
          </Button>
          <Button variant="outline" onClick={() => setBulkOpen(true)} className="gap-1.5">
            <Upload className="w-4 h-4" /> Bulk Import
          </Button>
          <Button variant="outline" onClick={generateKioskLink} disabled={generatingKioskToken} className="gap-1.5">
            {generatingKioskToken && <Loader2 className="w-4 h-4 animate-spin" />} Open kiosk
          </Button>
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }} className="gap-1.5">
            <Plus className="w-4 h-4" /> Add Staff
          </Button>
        </div>
      </div>
      {kioskToken && (
        <p className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Kiosk token generated. This link is now active; generating another token will invalidate older kiosk links.
        </p>
      )}

      {/* Stats */}
      <div className="flex items-center gap-4 mb-5 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5"><UserCheck className="w-4 h-4 text-green-500" /> {activeCount} active</span>
        {staff.length > activeCount && (
          <span className="flex items-center gap-1.5"><UserX className="w-4 h-4 text-muted-foreground" /> {staff.length - activeCount} inactive</span>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search staff…" className="pl-8 h-9" />
        </div>
        <button
          onClick={() => setShowInactive(v => !v)}
          className={cn("text-sm px-3 py-1.5 rounded-md border transition-colors", showInactive ? "bg-muted border-border" : "border-transparent text-muted-foreground hover:text-foreground")}
        >
          {showInactive ? "Hiding inactive" : "Show inactive"}
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-center gap-3">
          <div className="p-4 bg-indigo-50 rounded-2xl">
            <Users className="w-10 h-10 text-indigo-300" />
          </div>
          <div>
            <p className="font-medium">
              {staff.length === 0 ? "No staff added yet" : "No staff match your search"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {staff.length === 0 ? "Add staff members individually or use Bulk Import to paste a list." : "Try a different search."}
            </p>
          </div>
          {staff.length === 0 && (
            <div className="flex gap-2 mt-1">
              <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)} className="gap-1.5">
                <Upload className="w-3.5 h-3.5" /> Bulk Import
              </Button>
              <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add Staff
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Job Title</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Department</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">Site</th>
                 <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Status</th>
                 <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Kiosk PIN</th>
                <th className="px-4 py-3 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(s => (
                <tr key={s.id} className={cn("hover:bg-muted/20 transition-colors", !s.active && "opacity-50")}>
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{s.job_title ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{s.department ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{s.site_name ?? "All sites"}</td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
                      s.active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-500 border-gray-200")}>
                      {s.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                   <td className="px-4 py-3 hidden md:table-cell">
                     {(pinStatus[s.id] ?? s.has_pin ?? s.pin_set) ? (
                       <span className="text-xs text-green-700">Set <button className="underline ml-1" onClick={() => issuePinLink(s, true)}>Reset PIN</button></span>
                     ) : (
                       <span className="text-xs text-muted-foreground">Not set <button className="underline ml-1 text-foreground" onClick={() => issuePinLink(s, false)}>Create setup link</button></span>
                     )}
                     {enrollmentLinks[s.id] && <div className="text-[10px] text-muted-foreground mt-1 max-w-[180px] break-all">{enrollmentLinks[s.id]}</div>}
                   </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => { setEditing(s); setDialogOpen(true); }}
                        className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setDeleteTarget(s)}
                        className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <StaffDialog open={dialogOpen} onClose={() => { setDialogOpen(false); setEditing(null); }} onSaved={load} sites={sites} editing={editing} />
      <BulkImportDialog open={bulkOpen} onClose={() => setBulkOpen(false)} onImported={load} sites={sites} />

      <AlertDialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove staff member?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.name} will be removed from the roster. Existing acknowledgement records will be kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />} Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
