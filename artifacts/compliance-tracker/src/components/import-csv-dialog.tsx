import { useRef, useState } from "react";
import * as XLSX from "@e965/xlsx";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { API_BASE, getApiErrorMessage } from "@/lib/api";
import { downloadFile } from "@/lib/download";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type ImportCsvType = "pat-appliances" | "room-track-rooms" | "contractors" | "fire-call-points";

const IMPORTS: Record<ImportCsvType, { title: string; noun: string; one: string; required: string; optional: string; matching: string; template: string }> = {
  "pat-appliances": {
    title: "Import PAT appliances",
    noun: "appliances",
    one: "appliance",
    required: "Appliance name",
    optional: "Asset tag, Appliance type, Site, Location, Notes",
    matching: "Rows match existing appliances by asset tag, or by name, site and location when there is no asset tag.",
    template: "pattrack-appliances-template.csv",
  },
  "room-track-rooms": {
    title: "Import rooms",
    noun: "rooms",
    one: "room",
    required: "Room number",
    optional: "Room name, Floor, Site, Notes",
    matching: "Rows match existing rooms by site and room number.",
    template: "roomtrack-rooms-template.csv",
  },
  contractors: {
    title: "Import contractors",
    noun: "contractors",
    one: "contractor",
    required: "Contact name, Email",
    optional: "Company, Phone, Address, Trades (separate with ;), Gas Safe number, Public liability expiry (DD/MM/YYYY), Notes",
    matching: "Rows match existing contractors by email address.",
    template: "contractors-template.csv",
  },
  "fire-call-points": {
    title: "Upload call points",
    noun: "call points",
    one: "call point",
    required: "Call point",
    optional: "Location, Site (leave blank for the site chosen here)",
    matching: "List them in the order you want them tested: new call points join the end of the rotation in file order. Rows match existing call points by site and call point name.",
    template: "firetrack-call-points-template.csv",
  },
};

type RowAction = "create" | "update" | "skip" | "error";
interface ImportResult {
  preview: boolean;
  committed: boolean;
  summary: { total: number; create: number; update: number; skip: number; error: number };
  rows: Array<{ row: number; action: RowAction; label: string; reasons: string[] }>;
  ignoredHeaders: string[];
}

const ACTION_STYLE: Record<RowAction, { label: string; className: string }> = {
  create: { label: "New", className: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  update: { label: "Update", className: "bg-sky-50 text-sky-800 border-sky-200" },
  skip: { label: "Skip", className: "bg-muted text-muted-foreground border-border" },
  error: { label: "Error", className: "bg-rose-50 text-rose-800 border-rose-200" },
};

/** Read the first sheet of an Excel or CSV file as a header row plus cell text. */
async function readSpreadsheet(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
  // CSV text is read raw so "01/02/2027" stays a UK date string instead of
  // being reinterpreted as a US month/day date.
  const workbook = isCsv
    ? XLSX.read(await file.text(), { type: "string", raw: true })
    : XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { headers: [], rows: [] };
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false, dateNF: "yyyy-mm-dd" });
  const [headers = [], ...rows] = table;
  return { headers: headers.map(value => String(value ?? "")), rows: rows.map(row => row.map(value => String(value ?? ""))) };
}

export function ImportCsvDialog({ type, open, onOpenChange, onImported, siteId }: {
  type: ImportCsvType; open: boolean; onOpenChange: (open: boolean) => void; onImported?: () => void;
  /** FireTrack call points: the site for rows whose Site cell is blank. */
  siteId?: number | null;
}) {
  const config = IMPORTS[type];
  const { activeClientId } = useAuth();
  const clientApiFetch = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reading" | "preview" | "import" | null>(null);

  function reset() {
    setFile(null); setSheet(null); setResult(null); setError(null); setBusy(null);
    if (fileInput.current) fileInput.current.value = "";
  }
  function close() {
    if (busy === "import") return;
    reset();
    onOpenChange(false);
  }

  async function send(data: { headers: string[]; rows: string[][] }, preview: boolean) {
    const response = await clientApiFetch(`/imports/${type}`, { method: "POST", body: JSON.stringify({ ...data, preview, ...(siteId !== undefined ? { siteId } : {}) }) });
    const body = await response.json().catch(() => null) as (ImportResult & { error?: string }) | null;
    if (body?.rows) setResult(body);
    if (!response.ok) throw new Error(body?.error ?? await getApiErrorMessage(response, "The import could not be checked"));
    return body as ImportResult;
  }

  async function choose(selected: File) {
    reset();
    setFile(selected);
    setBusy("reading");
    try {
      const data = await readSpreadsheet(selected);
      if (!data.headers.length || !data.rows.length) throw new Error("The file has no rows below the header row");
      setSheet(data);
      setBusy("preview");
      await send(data, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The file could not be read");
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!sheet) return;
    setBusy("import");
    setError(null);
    try {
      const done = await send(sheet, false);
      toast({ title: `${config.noun[0].toUpperCase()}${config.noun.slice(1)} imported`, description: `${done.summary.create} added, ${done.summary.update} updated, ${done.summary.skip} skipped.` });
      await queryClient.invalidateQueries();
      onImported?.();
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nothing was imported");
      setBusy(null);
    }
  }

  async function downloadTemplate() {
    try {
      const query = activeClientId ? `?clientId=${encodeURIComponent(activeClientId)}` : "";
      await downloadFile(`${API_BASE}/imports/${type}/template${query}`, config.template);
    } catch (err) {
      toast({ title: "Template download failed", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    }
  }

  const summary = result?.summary;
  const canImport = !!summary && !result?.committed && summary.error === 0 && summary.create + summary.update > 0 && busy === null;

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="h-4 w-4" /> {config.title}</DialogTitle>
          <DialogDescription>
            Upload a CSV or Excel file. Nothing changes until you have checked the preview and confirmed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p><span className="font-medium text-foreground">Required column{config.required.includes(",") ? "s" : ""}:</span> {config.required}</p>
            <p><span className="font-medium text-foreground">Optional:</span> {config.optional}</p>
            <p>{config.matching} Blank cells leave existing details unchanged. Sites are matched by name. Up to 1,000 rows per file.</p>
            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={downloadTemplate} data-testid={`button-download-${type}-template`}>
              <Download className="mr-1 h-3.5 w-3.5" /> Download the template
            </Button>
          </div>

          <input ref={fileInput} type="file" accept=".csv,.xlsx,.xls" className="hidden" data-testid={`input-${type}-file`}
            onChange={event => { const selected = event.target.files?.[0]; if (selected) void choose(selected); }} />
          {!file ? (
            <button type="button" onClick={() => fileInput.current?.click()}
              className="w-full rounded-lg border-2 border-dashed p-6 text-center transition-colors hover:border-primary/50 hover:bg-muted/20">
              <FileSpreadsheet className="mx-auto mb-2 h-8 w-8 text-muted-foreground opacity-50" />
              <span className="text-sm font-medium text-muted-foreground">Choose a CSV or Excel file</span>
            </button>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/20 p-3">
              <FileSpreadsheet className="h-5 w-5 shrink-0 text-green-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {busy === "reading" || busy === "preview"
                    ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Checking…</span>
                    : summary ? `${summary.total} row${summary.total === 1 ? "" : "s"} checked` : ""}
                </p>
              </div>
              <button type="button" aria-label="Choose another file" onClick={reset} disabled={busy === "import"}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          {summary && (
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-4" data-testid="import-summary">
              <div><strong>{summary.create}</strong><br /><span className="text-muted-foreground">New</span></div>
              <div><strong>{summary.update}</strong><br /><span className="text-muted-foreground">Updated</span></div>
              <div><strong>{summary.skip}</strong><br /><span className="text-muted-foreground">Skipped</span></div>
              <div><strong className={summary.error ? "text-destructive" : undefined}>{summary.error}</strong><br /><span className="text-muted-foreground">Errors</span></div>
              {summary.error > 0 && <p className="col-span-2 text-xs text-destructive sm:col-span-4">Fix the rows marked as errors in your file and choose it again. Nothing is imported while any row has an error.</p>}
              {result?.ignoredHeaders.length ? <p className="col-span-2 text-xs text-muted-foreground sm:col-span-4">Columns not used: {result.ignoredHeaders.join(", ")}</p> : null}
            </div>
          )}

          {result && result.rows.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium text-muted-foreground">Row</th>
                    <th className="px-2 py-2 text-left font-medium text-muted-foreground">Result</th>
                    <th className="px-2 py-2 text-left font-medium text-muted-foreground">Record</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[...result.rows].sort((a, b) => Number(b.action === "error") - Number(a.action === "error") || a.row - b.row).map(row => (
                    <tr key={row.row} data-testid={`import-row-${row.row}`}>
                      <td className="px-2 py-1.5 align-top text-muted-foreground">{row.row}</td>
                      <td className="px-2 py-1.5 align-top">
                        <span className={cn("inline-block rounded-sm border px-1.5 py-0.5 font-medium", ACTION_STYLE[row.action].className)}>{ACTION_STYLE[row.action].label}</span>
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <span className="font-medium break-words">{row.label}</span>
                        {row.reasons.map(reason => <span key={reason} className="block break-words text-muted-foreground">{reason}</span>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy === "import"}>Cancel</Button>
          <Button onClick={confirm} disabled={!canImport} data-testid={`button-confirm-${type}-import`}>
            {busy === "import" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {summary ? `Import ${summary.create + summary.update} ${summary.create + summary.update === 1 ? config.one : config.noun}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Import CSV" button plus its dialog, for register pages. Hidden for users
 * the API would refuse: viewers, and staff other than PATTrack department
 * managers.
 */
export function ImportCsvButton({ type, onImported, className, siteId, label = "Import CSV" }: {
  type: ImportCsvType; onImported?: () => void; className?: string; siteId?: number | null; label?: string;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const isAdmin = user?.role === "consultant" || user?.role === "client_admin";
  const allowed = isAdmin || (type === "pat-appliances" && (user?.role === "client_manager" || (user?.role === "client_staff" && user.isDepartmentManager === true)));
  if (!allowed) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" className={className} onClick={() => setOpen(true)} data-testid={`button-import-${type}`}>
        <Upload className="mr-1 h-4 w-4" /> {label}
      </Button>
      <ImportCsvDialog type={type} open={open} onOpenChange={setOpen} onImported={onImported} siteId={siteId} />
    </>
  );
}
