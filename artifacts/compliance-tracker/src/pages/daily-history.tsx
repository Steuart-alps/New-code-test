import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, Sun, Moon, ShieldCheck, Printer, Search, ChevronLeft, ChevronRight } from "lucide-react";

interface Submission {
  id: number;
  siteId: number;
  siteName?: string;
  checklistDate: string;
  type: "am" | "pm";
  answers: { question: string; checked: boolean; notes?: string }[];
  submittedByName: string | null;
  submittedAt: string;
  signedOffByName: string | null;
  signedOffAt: string | null;
  signOffNotes: string | null;
}

interface Site { id: number; name: string; }

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// ── Print view ────────────────────────────────────────────────────────────────

function PrintView({ sub }: { sub: Submission }) {
  const checked = sub.answers.filter(a => a.checked).length;
  const isAm = sub.type === "am";
  return (
    <div className="print-content space-y-4 text-sm">
      {/* Header */}
      <div className="border-b border-border pb-4">
        <div className="flex items-center gap-2 mb-1">
          {isAm
            ? <Sun className="w-4 h-4 text-sky-500" />
            : <Moon className="w-4 h-4 text-indigo-500" />}
          <span className="font-semibold text-base">
            {isAm ? "Opening (AM) Checklist" : "Closing (PM) Checklist"}
          </span>
        </div>
        <div className="text-muted-foreground text-xs space-y-0.5">
          <p><span className="font-medium">Date:</span> {formatDate(sub.checklistDate)}</p>
          <p><span className="font-medium">Site:</span> {sub.siteName ?? `Site #${sub.siteId}`}</p>
          <p><span className="font-medium">Submitted by:</span> {sub.submittedByName ?? "Unknown"} at {formatTime(sub.submittedAt)}</p>
          {sub.signedOffAt && (
            <p><span className="font-medium">Signed off by:</span> {sub.signedOffByName} at {formatTime(sub.signedOffAt)}</p>
          )}
        </div>
      </div>

      {/* Summary */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
        <span>{checked} of {sub.answers.length} items checked</span>
      </div>

      {/* Answers */}
      <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
        {sub.answers.map((answer, i) => (
          <div key={i} className={`px-4 py-3 flex items-start gap-3 ${answer.checked ? "" : "bg-muted/30"}`}>
            <div className={`w-5 h-5 rounded flex-shrink-0 mt-0.5 flex items-center justify-center border
              ${answer.checked ? "bg-emerald-100 border-emerald-300" : "border-border bg-background"}`}>
              {answer.checked && <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className={answer.checked ? "text-foreground" : "text-muted-foreground"}>{answer.question}</p>
              {answer.notes && (
                <p className="text-xs text-muted-foreground mt-0.5 italic">Note: {answer.notes}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Sign-off notes */}
      {sub.signOffNotes && (
        <div className="bg-muted/30 rounded-lg p-3 text-xs">
          <span className="font-medium">Sign-off notes: </span>{sub.signOffNotes}
        </div>
      )}
    </div>
  );
}

// ── Detail dialog ─────────────────────────────────────────────────────────────

function DetailDialog({
  sub,
  onClose,
}: {
  sub: Submission | null;
  onClose: () => void;
}) {
  if (!sub) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <Dialog open={!!sub} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Checklist submission</DialogTitle>
            <Button variant="outline" size="sm" className="gap-1.5 print:hidden" onClick={handlePrint}>
              <Printer className="w-3.5 h-3.5" /> Print
            </Button>
          </div>
        </DialogHeader>
        <PrintView sub={sub} />
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export default function DailyHistoryPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  const [filterSite, setFilterSite] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterFrom, setFilterFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [filterTo, setFilterTo] = useState(() => new Date().toISOString().slice(0, 10));

  const [detail, setDetail] = useState<Submission | null>(null);

  // Load sites once
  useEffect(() => {
    apiFetch("/sites").then(r => r.ok ? r.json() : []).then(setSites);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from: filterFrom,
        to: filterTo,
        offset: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE),
      });
      if (filterSite !== "all") params.set("siteId", filterSite);
      if (filterType !== "all") params.set("type", filterType);

      const res = await apiFetch(`/daily-checklists/history?${params}`);
      if (res.ok) {
        const data = await res.json();
        setSubmissions(data.submissions);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [filterSite, filterType, filterFrom, filterTo, page]);

  useEffect(() => { setPage(0); }, [filterSite, filterType, filterFrom, filterTo]);
  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <AppLayout title="Checklist History">
      <DetailDialog sub={detail} onClose={() => setDetail(null)} />

      <div className="space-y-5">
        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1 flex-1 min-w-[140px]">
            <label className="text-xs font-medium text-muted-foreground">From</label>
            <Input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="space-y-1 flex-1 min-w-[140px]">
            <label className="text-xs font-medium text-muted-foreground">To</label>
            <Input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="space-y-1 flex-1 min-w-[140px]">
            <label className="text-xs font-medium text-muted-foreground">Site</label>
            <Select value={filterSite} onValueChange={setFilterSite}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sites</SelectItem>
                {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 flex-1 min-w-[120px]">
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">AM & PM</SelectItem>
                <SelectItem value="am">AM only</SelectItem>
                <SelectItem value="pm">PM only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Count */}
        {!loading && (
          <p className="text-xs text-muted-foreground">{total} submission{total !== 1 ? "s" : ""} found</p>
        )}

        {/* Table */}
        {loading ? (
          <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
        ) : submissions.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border rounded-xl text-muted-foreground text-sm">
            No submissions found for this date range.
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground hidden sm:table-cell">Site</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">Type</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground hidden md:table-cell">Submitted by</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground hidden md:table-cell">Status</th>
                  <th className="w-20 px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {submissions.map(sub => (
                  <tr
                    key={sub.id}
                    className="hover:bg-muted/20 transition-colors cursor-pointer"
                    onClick={() => setDetail(sub)}
                  >
                    <td className="px-5 py-3 text-sm whitespace-nowrap">
                      {new Date(sub.checklistDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground hidden sm:table-cell">
                      {sub.siteName ?? `Site #${sub.siteId}`}
                    </td>
                    <td className="px-5 py-3">
                      {sub.type === "am" ? (
                        <div className="flex items-center gap-1.5 text-sky-600 text-xs font-medium">
                          <Sun className="w-3.5 h-3.5" /> AM
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-indigo-600 text-xs font-medium">
                          <Moon className="w-3.5 h-3.5" /> PM
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground hidden md:table-cell">
                      {sub.submittedByName ?? "—"}
                    </td>
                    <td className="px-5 py-3 hidden md:table-cell">
                      {sub.type === "pm" ? (
                        sub.signedOffAt
                          ? <Badge variant="outline" className="text-xs border-emerald-200 text-emerald-700 bg-emerald-50 gap-1"><ShieldCheck className="w-3 h-3" />Signed off</Badge>
                          : <Badge variant="outline" className="text-xs border-amber-200 text-amber-700 bg-amber-50">Awaiting sign-off</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs border-emerald-200 text-emerald-700 bg-emerald-50 gap-1"><CheckCircle2 className="w-3 h-3" />Submitted</Badge>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={e => { e.stopPropagation(); setDetail(sub); }}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="gap-1.5">
              <ChevronLeft className="w-3.5 h-3.5" /> Previous
            </Button>
            <span className="text-muted-foreground text-xs">Page {page + 1} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} className="gap-1.5">
              Next <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
