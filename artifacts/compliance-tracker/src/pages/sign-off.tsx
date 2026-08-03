import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Shield, CheckCircle2, Loader2, Download, PenLine, ChevronRight,
  RotateCcw, FileText, FileSpreadsheet, File, Presentation,
  CheckSquare, User, Building2, LogOut,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ── Base fetch (no auth headers) ─────────────────────────────────────────────
const BASE = import.meta.env.BASE_URL ?? "/";
function pf(path: string, opts?: RequestInit) {
  const url = `${BASE}api${path}`;
  return fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface StaffMember { id: number; name: string; job_title: string | null; department: string | null; }
interface SignOffDoc {
  id: number; title: string; category: string; description: string | null;
  file_name: string; department: string | null;
  signed: boolean; acknowledged_at: string | null;
}

// ── Category labels ───────────────────────────────────────────────────────────
const CAT_LABEL: Record<string, string> = {
  risk_assessment: "Risk Assessment",
  sop: "SOP",
  handbook: "Handbook",
  policy: "Policy",
  procedure: "Procedure",
  other: "Document",
};

function fileIcon(mimeType: string) {
  if (mimeType.includes("pdf") || mimeType.includes("word") || mimeType.includes("text")) return FileText;
  if (mimeType.includes("sheet") || mimeType.includes("excel") || mimeType.includes("csv")) return FileSpreadsheet;
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return Presentation;
  return File;
}

// ── Signature canvas ──────────────────────────────────────────────────────────
function SignatureCanvas({
  onChange,
  onClear,
}: {
  onChange: (dataUrl: string) => void;
  onClear: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const hasStrokes = useRef(false);

  function getPos(e: MouseEvent | Touch, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    drawing.current = true;
    const canvas = canvasRef.current!;
    const ev = "touches" in e ? e.touches[0] : e;
    lastPos.current = getPos(ev as any, canvas);
  }

  function draw(e: React.MouseEvent | React.TouchEvent) {
    if (!drawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const ev = "touches" in e ? e.touches[0] : e;
    const pos = getPos(ev as any, canvas);

    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    lastPos.current = pos;
    hasStrokes.current = true;
    onChange(canvas.toDataURL("image/png"));
  }

  function endDraw() { drawing.current = false; }

  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    hasStrokes.current = false;
    onClear();
  }

  return (
    <div className="space-y-2">
      <div className="relative border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 overflow-hidden">
        <canvas
          ref={canvasRef}
          width={600}
          height={200}
          className="w-full touch-none cursor-crosshair block"
          style={{ height: "clamp(140px, 25vw, 200px)" }}
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
          onTouchEnd={endDraw}
        />
        <p className="absolute inset-0 flex items-center justify-center text-slate-300 text-sm pointer-events-none select-none">
          Sign here
        </p>
      </div>
      <button
        onClick={clear}
        className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 transition-colors"
      >
        <RotateCcw className="w-3 h-3" /> Clear signature
      </button>
    </div>
  );
}

// ── Sign dialog ───────────────────────────────────────────────────────────────
function SignDialog({
  doc,
  token,
  staffMember,
  open,
  onClose,
  onSigned,
}: {
  doc: SignOffDoc;
  token: string;
  staffMember: StaffMember;
  open: boolean;
  onClose: () => void;
  onSigned: () => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"draw" | "type">("draw");
  const [drawnSig, setDrawnSig] = useState<string | null>(null);
  const [typedName, setTypedName] = useState("");
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const canSign = tab === "draw" ? !!drawnSig : typedName.trim().length >= 2;

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await pf(`/sign-off/${token}/documents/${doc.id}/download`);
      if (!res.ok) throw new Error("Failed");
      const { downloadUrl } = await res.json();
      window.open(downloadUrl, "_blank", "noopener");
    } catch {
      toast({ title: "Could not open document", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }

  async function handleSign() {
    if (!canSign) return;
    setSaving(true);
    try {
      const res = await pf(`/sign-off/${token}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({
          documentId: doc.id,
          staffRosterId: staffMember.id,
          staffName: staffMember.name,
          signature: tab === "draw" ? drawnSig : null,
          typedName: tab === "type" ? typedName.trim() : null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed");
      }
      onSigned();
      onClose();
      toast({ title: "Document signed", description: `${doc.title} recorded.` });
    } catch (err: any) {
      toast({ title: "Sign failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <PenLine className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{doc.title}</span>
          </DialogTitle>
        </DialogHeader>

        {/* Doc info */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
              {CAT_LABEL[doc.category] ?? doc.category}
            </span>
            {doc.department && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100">
                {doc.department}
              </span>
            )}
          </div>

          {doc.description && (
            <p className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3">{doc.description}</p>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Open & read document before signing
          </Button>

          <hr />

          {/* Signing as */}
          <p className="text-sm text-slate-600">
            Signing as: <strong>{staffMember.name}</strong>
            {staffMember.job_title && ` — ${staffMember.job_title}`}
          </p>

          {/* Signature tabs */}
          <div className="flex rounded-lg border overflow-hidden text-sm">
            <button
              className={cn("flex-1 py-2 font-medium transition-colors flex items-center justify-center gap-1.5",
                tab === "draw" ? "bg-slate-800 text-white" : "bg-muted/40 text-muted-foreground hover:text-foreground")}
              onClick={() => setTab("draw")}
            >
              <PenLine className="w-3.5 h-3.5" /> Draw signature
            </button>
            <button
              className={cn("flex-1 py-2 font-medium transition-colors",
                tab === "type" ? "bg-slate-800 text-white" : "bg-muted/40 text-muted-foreground hover:text-foreground")}
              onClick={() => setTab("type")}
            >
              Type name
            </button>
          </div>

          {tab === "draw" ? (
            <SignatureCanvas
              onChange={url => setDrawnSig(url)}
              onClear={() => setDrawnSig(null)}
            />
          ) : (
            <div className="space-y-1.5">
              <input
                className="w-full border rounded-lg px-4 py-3 text-base font-medium focus:outline-none focus:ring-2 focus:ring-slate-800"
                placeholder="Type your full name to confirm"
                value={typedName}
                onChange={e => setTypedName(e.target.value)}
                autoFocus
              />
              <p className="text-xs text-slate-500">
                Typing your name serves as your electronic signature confirming you have read this document.
              </p>
            </div>
          )}

          {/* Confirm */}
          <Button
            className="w-full py-3 text-base"
            onClick={handleSign}
            disabled={!canSign || saving}
          >
            {saving ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Saving…</>
            ) : (
              <><CheckSquare className="w-4 h-4 mr-2" /> Confirm & Sign</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main sign-off page ────────────────────────────────────────────────────────
export default function SignOffPage() {
  const token = window.location.pathname.split("/sign-off/")[1]?.split("/")[0] ?? "";
  const { toast } = useToast();

  const [clientName, setClientName] = useState<string | null>(null);
  const [departments, setDepartments] = useState<string[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [docs, setDocs] = useState<SignOffDoc[]>([]);

  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);
  const [signDoc, setSignDoc] = useState<SignOffDoc | null>(null);

  const [loadingInfo, setLoadingInfo] = useState(true);
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // Load client info + departments
  useEffect(() => {
    if (!token) { setInvalid(true); setLoadingInfo(false); return; }
    Promise.all([
      pf(`/sign-off/${token}/info`),
      pf(`/sign-off/${token}/departments`),
    ]).then(async ([infoRes, deptRes]) => {
      if (!infoRes.ok) { setInvalid(true); return; }
      const info = await infoRes.json();
      setClientName(info.clientName);
      if (deptRes.ok) setDepartments(await deptRes.json());
    }).catch(() => setInvalid(true))
      .finally(() => setLoadingInfo(false));
  }, [token]);

  // Load staff when dept selected
  useEffect(() => {
    if (!selectedDept) return;
    setSelectedStaff(null);
    setDocs([]);
    setLoadingStaff(true);
    pf(`/sign-off/${token}/staff?department=${encodeURIComponent(selectedDept)}`)
      .then(r => r.ok ? r.json() : [])
      .then(setStaff)
      .finally(() => setLoadingStaff(false));
  }, [selectedDept, token]);

  // Load docs when staff selected
  useEffect(() => {
    if (!selectedStaff || !selectedDept) return;
    setLoadingDocs(true);
    pf(`/sign-off/${token}/documents?department=${encodeURIComponent(selectedDept)}&staffId=${selectedStaff.id}`)
      .then(r => r.ok ? r.json() : [])
      .then(setDocs)
      .finally(() => setLoadingDocs(false));
  }, [selectedStaff, selectedDept, token]);

  const refreshDocs = useCallback(() => {
    if (!selectedStaff || !selectedDept) return;
    pf(`/sign-off/${token}/documents?department=${encodeURIComponent(selectedDept)}&staffId=${selectedStaff.id}`)
      .then(r => r.ok ? r.json() : [])
      .then(setDocs);
  }, [selectedStaff, selectedDept, token]);

  function reset() {
    setSelectedDept(null);
    setSelectedStaff(null);
    setDocs([]);
    setStaff([]);
  }

  if (loadingInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (invalid || !clientName) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="text-center max-w-xs">
          <Shield className="w-12 h-12 mx-auto mb-4 text-slate-300" />
          <h2 className="text-lg font-semibold text-slate-700">Invalid sign-off link</h2>
          <p className="text-sm text-slate-500 mt-2">
            This link is no longer valid. Please ask your manager for the correct link.
          </p>
        </div>
      </div>
    );
  }

  const allSigned = docs.length > 0 && docs.every(d => d.signed);
  const unsignedCount = docs.filter(d => !d.signed).length;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Shield className="w-6 h-6 text-slate-700 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-slate-800 text-sm leading-tight">ComplyTrack</p>
            <p className="text-xs text-slate-500 truncate">{clientName}</p>
          </div>
          {selectedStaff && (
            <button
              onClick={reset}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-100"
            >
              <LogOut className="w-3.5 h-3.5" /> Change
            </button>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">

        {/* ── Step 1: Department ─────────────────────────────────────────── */}
        {!selectedDept && (
          <div className="space-y-4">
            <div className="text-center space-y-1">
              <Building2 className="w-8 h-8 mx-auto text-slate-400" />
              <h1 className="text-xl font-semibold text-slate-800">Select your department</h1>
              <p className="text-sm text-slate-500">Tap your team to see your documents</p>
            </div>

            {departments.length === 0 ? (
              <div className="text-center text-slate-400 py-8">
                <p className="text-sm">No departments have been set up yet.</p>
                <p className="text-xs mt-1">Ask your manager to add departments in the Staff Roster.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {departments.map(dept => (
                  <button
                    key={dept}
                    onClick={() => setSelectedDept(dept)}
                    className="p-4 bg-white rounded-xl border shadow-sm hover:shadow-md hover:border-slate-300 active:scale-95 transition-all text-left"
                  >
                    <Building2 className="w-5 h-5 text-slate-400 mb-2" />
                    <p className="font-medium text-slate-800 text-sm leading-snug">{dept}</p>
                    <ChevronRight className="w-4 h-4 text-slate-300 mt-1" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Staff selection ────────────────────────────────────── */}
        {selectedDept && !selectedStaff && (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1">
                ← Back
              </button>
              <span className="text-xs text-slate-300">/</span>
              <span className="text-xs font-medium text-slate-600">{selectedDept}</span>
            </div>

            <div className="text-center space-y-1">
              <User className="w-8 h-8 mx-auto text-slate-400" />
              <h1 className="text-xl font-semibold text-slate-800">Who are you?</h1>
              <p className="text-sm text-slate-500">Select your name from the list</p>
            </div>

            {loadingStaff ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : staff.length === 0 ? (
              <div className="text-center text-slate-400 py-8">
                <p className="text-sm">No staff found in {selectedDept}.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <Select
                  onValueChange={val => {
                    const member = staff.find(s => String(s.id) === val);
                    if (member) setSelectedStaff(member);
                  }}
                >
                  <SelectTrigger className="w-full py-4 text-base h-auto">
                    <SelectValue placeholder="Select your name…" />
                  </SelectTrigger>
                  <SelectContent>
                    {staff.map(s => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        <div>
                          <p className="font-medium">{s.name}</p>
                          {s.job_title && <p className="text-xs text-muted-foreground">{s.job_title}</p>}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-center text-slate-400">
                  Not in the list? Ask your manager to add you to the staff roster.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Documents ──────────────────────────────────────────── */}
        {selectedStaff && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => { setSelectedStaff(null); setDocs([]); }}
                className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1">
                ← Back
              </button>
              <span className="text-xs text-slate-300">/</span>
              <span className="text-xs font-medium text-slate-600">{selectedDept}</span>
              <span className="text-xs text-slate-300">/</span>
              <span className="text-xs font-medium text-slate-600">{selectedStaff.name}</span>
            </div>

            {loadingDocs ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : docs.length === 0 ? (
              <div className="text-center py-12 space-y-2">
                <CheckCircle2 className="w-12 h-12 mx-auto text-green-400" />
                <p className="font-semibold text-slate-700">No documents to sign</p>
                <p className="text-sm text-slate-500">
                  There are no documents requiring your acknowledgement right now.
                </p>
              </div>
            ) : allSigned ? (
              <div className="text-center py-12 space-y-3">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-9 h-9 text-green-500" />
                </div>
                <h2 className="text-xl font-semibold text-slate-800">All signed!</h2>
                <p className="text-sm text-slate-500">
                  You have acknowledged all required documents. Thank you.
                </p>
                <Button variant="outline" className="mt-2" onClick={reset}>
                  Done — return to start
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-slate-800">Your documents</h2>
                  <span className="text-sm text-slate-500">
                    {docs.filter(d => d.signed).length}/{docs.length} signed
                  </span>
                </div>

                {unsignedCount > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800 flex items-center gap-2">
                    <CheckSquare className="w-4 h-4 flex-shrink-0" />
                    {unsignedCount} document{unsignedCount > 1 ? "s" : ""} need{unsignedCount === 1 ? "s" : ""} your signature
                  </div>
                )}

                <div className="space-y-3">
                  {docs.map(doc => {
                    const Icon = fileIcon(doc.file_name);
                    return (
                      <div
                        key={doc.id}
                        className={cn(
                          "bg-white rounded-xl border shadow-sm p-4 transition-all",
                          doc.signed ? "border-green-200 bg-green-50/30" : "border-slate-200",
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <div className={cn(
                            "p-2.5 rounded-lg flex-shrink-0",
                            doc.signed ? "bg-green-100" : "bg-slate-100",
                          )}>
                            {doc.signed
                              ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                              : <Icon className="w-5 h-5 text-slate-500" />
                            }
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-slate-800 leading-snug">{doc.title}</p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {CAT_LABEL[doc.category] ?? doc.category}
                              {doc.department && ` · ${doc.department}`}
                            </p>
                            {doc.description && (
                              <p className="text-xs text-slate-500 mt-1 line-clamp-2">{doc.description}</p>
                            )}
                            {doc.signed && doc.acknowledged_at && (
                              <p className="text-xs text-green-600 mt-1 font-medium">
                                Signed {new Date(doc.acknowledged_at).toLocaleDateString("en-GB", {
                                  day: "2-digit", month: "short", year: "numeric",
                                })}
                              </p>
                            )}
                          </div>
                        </div>

                        {!doc.signed && (
                          <Button
                            className="w-full mt-3 gap-2"
                            size="sm"
                            onClick={() => setSignDoc(doc)}
                          >
                            <PenLine className="w-4 h-4" /> Read & Sign
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {/* Sign dialog */}
      {signDoc && selectedStaff && (
        <SignDialog
          doc={signDoc}
          token={token}
          staffMember={selectedStaff}
          open={!!signDoc}
          onClose={() => setSignDoc(null)}
          onSigned={() => { setSignDoc(null); refreshDocs(); }}
        />
      )}
    </div>
  );
}
