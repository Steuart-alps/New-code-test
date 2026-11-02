import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, FileSpreadsheet, X, Download, GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";
import { downloadExcel, readSpreadsheet } from "@/lib/spreadsheet";
import { SpreadsheetDropZone, isSpreadsheetFile, usePastedFile } from "@/components/spreadsheet-drop-zone";
import { ListReadNote, ListReadingPanel, isPhotoOrPdf, useListReading, type ListReadResult } from "@/components/ai-list-reader";

// Replace a site's (or the whole business's) staff roster with an uploaded
// one: from Staff Roster (Owners), and from the monthly roster check when the
// answer is Yes (lib/rosterChecks.ts on the API). The preview names who is
// new, who has left and who has come back; nobody is deleted.

interface Site { id: number; name: string; }

type Summary = { total: number; created: number; updated: number; reactivated: number; unchanged: number; deactivated: number; matchedByEmail: number; matchedByName: number };
type People = {
  created: Array<{ name: string; jobTitle: string | null }>;
  reactivated: Array<{ id: number; name: string }>;
  updated: Array<{ id: number; name: string }>;
  deactivated: Array<{ id: number; name: string; hasAccount: boolean }>;
};
export type RosterImportResult = {
  summary: Summary;
  people: People;
  newStarters: Array<{ id: number; name: string }>;
  /** Certificates already held at the site: what new starters show as Missing in the training matrix. */
  trainingNeeded: string[];
  rosterCheck?: { recorded: boolean; note: string | null };
};

interface ParsedStaff {
  /** Optional: rosters from small businesses often have none. */
  externalPayrollId: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
  email: string | null;
}

/** Staff rows from an Excel or CSV file, a Word table or a text list. */
async function parseExcel(file: File): Promise<ParsedStaff[]> {
  const { headers, rows } = await readSpreadsheet(file, { sheet: "Staff roster" });
  return parseStaffTable(headers, rows);
}

/** Staff rows from a header row and its rows (a spreadsheet, or a list ComplyTrack read). */
function parseStaffTable(headers: string[], rows: string[][]): ParsedStaff[] {
  // Normalise header names
  const normalise = (k: string) => k.toLowerCase().replace(/[\s_-]/g, "");
  const keys = headers.map(normalise);
  const find = (row: string[], ...names: string[]) => {
    const index = keys.findIndex(key => names.includes(key));
    return index >= 0 ? (row[index] ?? "").trim() || null : null;
  };

  return rows
    .map(row => ({
      externalPayrollId: find(row, "payrollid", "employeeid", "staffid", "workforceid", "identifier") ?? "",
      name:       find(row, "name", "fullname", "staffname", "employeename") ?? "",
      jobTitle:   find(row, "jobtitle", "title", "role", "position", "job"),
      department: find(row, "department", "dept", "team", "area", "division"),
      email:      find(row, "email", "emailaddress", "mail"),
    }))
    .filter(m => m.name.length > 0 || m.externalPayrollId.length > 0);
}

function downloadStaffTemplate() {
  downloadExcel("staff-roster-template.xlsx", "Staff", [
    ["Payroll ID", "Name", "Job Title", "Department", "Email"],
    ["1001", "Jane Smith", "Chef de partie", "Kitchen", "jane.smith@example.com"],
  ]);
}

function parsePasteText(text: string): ParsedStaff[] {
  return text.split("\n")
    .map(l => l.trim()).filter(Boolean)
    .map(line => {
      const fields = line.split(",").map(s => s.trim());
      // A line with just a name has no payroll ID.
      if (fields.length === 1) return { externalPayrollId: "", name: fields[0], jobTitle: null, department: null, email: null };
      const [externalPayrollId, name, jobTitle, department, email] = fields;
      return { externalPayrollId: externalPayrollId || "", name: name || "", jobTitle: jobTitle || null, department: department || null, email: email || null };
    })
    .filter(m => m.name);
}

function PeopleList({ title, names, tone }: { title: string; names: string[]; tone: "green" | "amber" | "slate" }) {
  if (!names.length) return null;
  const colour = tone === "green" ? "text-emerald-700" : tone === "amber" ? "text-amber-800" : "text-slate-700";
  return (
    <div>
      <p className={cn("text-xs font-semibold", colour)}>{title} ({names.length})</p>
      <p className="text-sm">{names.join(", ")}</p>
    </div>
  );
}

export function RosterImportDialog({ open, onClose, onImported, sites, fixedSite = null, rosterCheck = null, initialFile = null }: {
  open: boolean; onClose: () => void; onImported: (result: RosterImportResult) => void; sites: Site[];
  /** Update just this site's roster (no site picker). */
  fixedSite?: Site | null;
  /** Answer Yes to this month's roster check with the upload. */
  rosterCheck?: { taskId: number; date: string } | null;
  /** A file chosen before the dialog opened ("Upload your lists"), read as soon as it opens. */
  initialFile?: File | null;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"excel" | "paste">("excel");
  const [text, setText] = useState("");
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ParsedStaff[]>([]);
  const [siteId, setSiteId] = useState("none");
  const [importing, setImporting] = useState(false);
  const [parsing, setParsing] = useState(false);
  // A photo or document of the roster read by ComplyTrack (AI add-on).
  const reading = useListReading("staff-roster", open);
  const [readFromList, setReadFromList] = useState<ListReadResult | null>(null);
  const [reconciliation, setReconciliation] = useState<{ summary: Summary; people: People } | null>(null);
  const [result, setResult] = useState<RosterImportResult | null>(null);
  const chosenSiteId = fixedSite ? String(fixedSite.id) : siteId;

  function reset() {
    setText(""); setExcelFile(null); setPreview([]);
    setSiteId("none"); setMode("excel"); setReconciliation(null); setReadFromList(null); setResult(null);
  }

  async function handleFileChange(file: File) {
    if (!isSpreadsheetFile(file)) {
      if (reading.canRead && isPhotoOrPdf(file)) return void handleListFile(file);
      toast({ title: "That isn't a spreadsheet", description: isPhotoOrPdf(file) && reading.status ? "Reading a photo, screenshot or PDF needs the AI features add-on. Or choose an Excel (.xlsx or .xls) or CSV file." : "Choose an Excel (.xlsx or .xls) or CSV file.", variant: "destructive" });
      return;
    }
    setReadFromList(null);
    setExcelFile(file);
    setParsing(true);
    try {
      const members = await parseExcel(file);
      setPreview(members);
      setReconciliation(null);
    } catch (err) {
      toast({ title: "Could not read file", description: err instanceof Error && err.message ? err.message : "Make sure it is an Excel (.xlsx or .xls) or CSV file.", variant: "destructive" });
      setExcelFile(null);
    } finally {
      setParsing(false);
    }
  }

  async function handleListFile(file: File) {
    setExcelFile(file);
    setPreview([]);
    setReadFromList(null);
    setReconciliation(null);
    setParsing(true);
    try {
      const read = await reading.read(file);
      setPreview(parseStaffTable(read.headers, read.rows));
      setReadFromList(read);
    } catch (err) {
      toast({ title: "Could not read the list", description: err instanceof Error && err.message ? err.message : "Try again, or upload a spreadsheet.", variant: "destructive" });
      setExcelFile(null);
    } finally {
      setParsing(false);
    }
  }

  usePastedFile(open && !result && mode === "excel" && !excelFile && !parsing, file => void handleFileChange(file));
  const startedWith = useRef<File | null>(null);
  useEffect(() => {
    if (!open) { startedWith.current = null; return; }
    if (!initialFile || !reading.loaded || startedWith.current === initialFile) return;
    startedWith.current = initialFile;
    void handleFileChange(initialFile);
  }, [open, initialFile, reading.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const members: ParsedStaff[] = mode === "excel" ? preview : parsePasteText(text);
  const canImport = members.length > 0 && members.every(member => member.name.trim()) && !importing;

  async function handleImport() {
    if (!members.length) return;
    setImporting(true);
    try {
      const site = chosenSiteId !== "none" ? Number(chosenSiteId) : null;
      const body = {
        rows: members.map(m => ({ ...m, externalPayrollId: m.externalPayrollId.trim() || null, siteId: site })),
        siteId: site,
        preview: !reconciliation,
        ...(rosterCheck ? { rosterCheck } : {}),
      };
      const res = await apiFetch("/staff-roster/reconcile", { method: "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        const rows = Array.isArray(data.errors) ? data.errors.slice(0, 3).map((e: { row: number; error: string }) => `Row ${e.row}: ${e.error}`) : [];
        throw new Error([data.error ?? "Roster reconciliation failed", ...rows].join(". "));
      }
      if (!reconciliation) {
        setReconciliation({ summary: data.summary, people: data.people });
        return;
      }
      toast({ title: "Staff roster updated", description: `${data.summary.created} new, ${data.summary.deactivated} marked as left, ${data.summary.updated + data.summary.reactivated} updated.` });
      setResult(data);
      onImported(data);
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
          <DialogTitle className="flex items-center gap-2"><Upload className="w-4 h-4" /> {fixedSite ? `Update the staff roster: ${fixedSite.name}` : "Replace monthly staff roster"}</DialogTitle>
        </DialogHeader>

        {result ? <ImportResult result={result} /> : <div className="space-y-4 py-1">
          {/* Mode tabs */}
          <div className="flex rounded-lg border overflow-hidden text-sm">
            <button
              className={cn("flex-1 py-2 font-medium transition-colors flex items-center justify-center gap-1.5",
                mode === "excel" ? "bg-primary text-primary-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground")}
              onClick={() => setMode("excel")}
            >
              <FileSpreadsheet className="w-4 h-4" /> Upload a spreadsheet
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
                 Upload the complete current roster as an Excel spreadsheet (a CSV file works too). Required column: <strong>Name</strong>. Optional columns: Payroll ID (recommended: it keeps people matched if their name changes), Job Title, Department and Email.
              </p>
              <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={downloadStaffTemplate} data-testid="button-download-staff-roster-template">
                <Download className="mr-1 h-3.5 w-3.5" /> Download the Excel template
              </Button>
              {!excelFile ? (
                <>
                  <SpreadsheetDropZone onFile={handleFileChange} aiReading={reading.canRead} testId="input-staff-roster-file" />
                  <ListReadingPanel reading={reading} kind="staff-roster" noun="staff" onFile={file => void handleListFile(file)} onSpreadsheet={handleFileChange} />
                </>
              ) : (
                <div className="flex items-center gap-3 p-3 border rounded-lg bg-muted/20">
                  <FileSpreadsheet className="w-5 h-5 text-green-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{excelFile.name}</p>
                    {parsing ? (
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> {readFromList === null && !isSpreadsheetFile(excelFile) ? "Reading your list… this can take a minute" : "Reading…"}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">{preview.length} staff member{preview.length === 1 ? "" : "s"} found</p>
                    )}
                  </div>
                  <button onClick={() => { setExcelFile(null); setPreview([]); setReadFromList(null); }}
                    className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {readFromList && (
                <ListReadNote result={readFromList} noun="staff" one="member of staff" kind="staff-roster"
                  onDownload={() => downloadExcel("staff-roster-read-from-list.xlsx", "Staff", [readFromList.headers, ...readFromList.rows])} />
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
                One staff member per line: just a name, or payroll ID, name, then optional job title, department and email.
              </p>
              <div className="bg-muted/40 rounded-md p-3 text-xs text-muted-foreground font-mono space-y-0.5">
                <p>John Smith</p>
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

          {sites.length > 0 && !fixedSite && (
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
            This is a complete replacement for {chosenSiteId === "none" ? "the whole current roster" : fixedSite ? `${fixedSite.name}'s current roster` : "the selected site's current roster"}. Staff missing from the file will be marked as left, never deleted. Their training and compliance history will remain.
          </div>
          {members.some(member => !member.name.trim()) && <p className="text-sm text-destructive">Every row needs a name.</p>}
          {reconciliation && <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm" data-testid="roster-preview">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><strong>{reconciliation.summary.created}</strong><br /><span className="text-muted-foreground">New starters</span></div>
              <div><strong>{reconciliation.summary.deactivated}</strong><br /><span className="text-muted-foreground">Left</span></div>
              <div><strong>{reconciliation.summary.reactivated}</strong><br /><span className="text-muted-foreground">Coming back</span></div>
              <div><strong>{reconciliation.summary.updated}</strong><br /><span className="text-muted-foreground">Details updated</span></div>
            </div>
            <PeopleList title="New starters" tone="green" names={reconciliation.people.created.map(p => p.jobTitle ? `${p.name} (${p.jobTitle})` : p.name)} />
            <PeopleList title="Left: marked as left, records kept" tone="amber" names={reconciliation.people.deactivated.map(p => p.name)} />
            <PeopleList title="Coming back" tone="slate" names={reconciliation.people.reactivated.map(p => p.name)} />
            {reconciliation.people.deactivated.some(p => p.hasAccount) && (
              <p className="text-xs text-amber-900">
                {reconciliation.people.deactivated.filter(p => p.hasAccount).map(p => p.name).join(", ")} can still sign in to ComplyTrack. Remove their login in Users.
              </p>
            )}
            {reconciliation.summary.created + reconciliation.summary.deactivated + reconciliation.summary.reactivated === 0 && (
              <p className="text-xs text-muted-foreground">No one has joined or left.</p>
            )}
            {(reconciliation.summary.matchedByEmail + reconciliation.summary.matchedByName) > 0 && <p className="text-xs text-muted-foreground">{reconciliation.summary.matchedByEmail + reconciliation.summary.matchedByName} existing staff matched by email or name and will keep their history.</p>}
          </div>}
        </div>}

        <DialogFooter>
          {result ? (
            <Button onClick={() => { reset(); onClose(); }}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={importing}>Cancel</Button>
              <Button onClick={handleImport} disabled={!canImport}>
                {importing && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                {reconciliation ? "Confirm the new roster" : `Preview ${members.length > 0 ? `${members.length} staff` : "roster"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** After the upload: who joined (and the training they need) and who left. */
function ImportResult({ result }: { result: RosterImportResult }) {
  const { people, newStarters, trainingNeeded } = result;
  return (
    <div className="space-y-4 py-1 text-sm" data-testid="roster-import-result">
      {result.rosterCheck && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
          {result.rosterCheck.recorded ? "This month's roster check is done." : "This month's roster check had already been answered; the roster has still been updated."}
        </p>
      )}
      {newStarters.length > 0 && (
        <div className="rounded-md border p-3 space-y-2">
          <p className="font-semibold flex items-center gap-1.5"><GraduationCap className="w-4 h-4 text-primary" /> New starters added to TrainTrack</p>
          <p>{newStarters.map(p => p.name).join(", ")}</p>
          {trainingNeeded.length > 0 ? (
            <p className="text-muted-foreground">
              Training they need, as the rest of the team has: <strong className="text-foreground">{trainingNeeded.join(", ")}</strong>. It shows as Missing in the training matrix until their certificates are added.
            </p>
          ) : (
            <p className="text-muted-foreground">Add their certificates in TrainTrack as they complete their training.</p>
          )}
          <p className="text-muted-foreground">Documents staff must read and sign are asked of them automatically.</p>
          <Link href="/train-track" className="inline-block text-primary hover:underline">Open TrainTrack</Link>
        </div>
      )}
      {people.deactivated.length > 0 && (
        <div className="rounded-md border p-3 space-y-1">
          <p className="font-semibold">Marked as left</p>
          <p>{people.deactivated.map(p => p.name).join(", ")}</p>
          <p className="text-muted-foreground">Their training records and sign-offs are kept. Show them again on Staff Roster with "Show inactive".</p>
          {people.deactivated.some(p => p.hasAccount) && (
            <p className="text-amber-900">{people.deactivated.filter(p => p.hasAccount).map(p => p.name).join(", ")} can still sign in. Remove their login in Users.</p>
          )}
        </div>
      )}
      {people.reactivated.length > 0 && <p>Back on the roster: {people.reactivated.map(p => p.name).join(", ")}.</p>}
      {newStarters.length + people.deactivated.length + people.reactivated.length === 0 && <p>No one joined or left; the roster is up to date.</p>}
    </div>
  );
}
