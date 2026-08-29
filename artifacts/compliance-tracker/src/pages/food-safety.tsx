import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertCircle, ChevronLeft, ChevronRight, ClipboardCheck, CalendarDays } from "lucide-react";

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function offsetDate(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(ym: string): string {
  return `${ym}-01`;
}

function endOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

function daysInMonth(ym: string): string[] {
  const first = new Date(`${ym}-01`);
  const days: string[] = [];
  const cur = new Date(first);
  while (cur.getMonth() === first.getMonth()) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function currentYM(): string {
  return todayStr().slice(0, 7);
}

function prevYM(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function nextYM(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function dayLabel(date: string) {
  return new Date(date).toLocaleDateString("en-GB", { weekday: "short" });
}

function dayNum(date: string) {
  return Number(date.slice(8));
}

// Day-of-week offset for the first of the month (Mon=0)
function firstDow(ym: string): number {
  const d = new Date(`${ym}-01`);
  return (d.getDay() + 6) % 7; // Mon=0..Sun=6
}

// ── Gaps endpoint ─────────────────────────────────────────────────────────────

async function fetchGaps(from: string, to: string): Promise<{ recorded: Set<string>; gaps: string[] }> {
  const res = await apiFetch(`/food-safety/gaps?from=${from}&to=${to}`);
  if (!res.ok) return { recorded: new Set(), gaps: [] };
  const data: { recorded: string[]; gaps: string[] } = await res.json();
  return { recorded: new Set(data.recorded), gaps: data.gaps };
}

// ── Calendar grid ─────────────────────────────────────────────────────────────

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function CalendarGrid({
  ym,
  recorded,
  gaps,
  today,
}: {
  ym: string;
  recorded: Set<string>;
  gaps: string[];
  today: string;
}) {
  const days = daysInMonth(ym);
  const offset = firstDow(ym);
  const gapSet = new Set(gaps);

  return (
    <div>
      {/* Day-of-week header */}
      <div className="grid grid-cols-7 mb-1">
        {DOW_LABELS.map((d) => (
          <div key={d} className="text-center text-xs text-muted-foreground py-1 font-medium">{d}</div>
        ))}
      </div>
      {/* Grid */}
      <div className="grid grid-cols-7 gap-1">
        {/* Leading empty cells */}
        {Array.from({ length: offset }).map((_, i) => (
          <div key={`e-${i}`} />
        ))}
        {days.map((date) => {
          const isFuture = date > today;
          const isToday = date === today;
          const isRecorded = recorded.has(date);
          const isMissing = gapSet.has(date);

          let cellClass =
            "aspect-square rounded-lg flex flex-col items-center justify-center text-xs font-medium transition-colors border ";

          if (isFuture) {
            cellClass += "bg-muted/20 border-border/30 text-muted-foreground/40 cursor-default";
          } else if (isRecorded) {
            cellClass += "bg-emerald-50 border-emerald-200 text-emerald-700";
          } else if (isMissing) {
            cellClass += isToday
              ? "bg-amber-50 border-amber-300 text-amber-700 ring-2 ring-amber-400 ring-offset-1"
              : "bg-red-50 border-red-200 text-red-600";
          } else {
            cellClass += "bg-muted/30 border-border/50 text-muted-foreground";
          }

          return (
            <div key={date} className={cellClass} title={date}>
              <span>{dayNum(date)}</span>
              {isRecorded && <CheckCircle2 className="w-2.5 h-2.5 mt-0.5 opacity-70" />}
              {isMissing && !isFuture && <AlertCircle className="w-2.5 h-2.5 mt-0.5 opacity-70" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FoodSafetyPage() {
  const today = todayStr();
  const [ym, setYm] = useState(currentYM());
  const [recorded, setRecorded] = useState<Set<string>>(new Set());
  const [gaps, setGaps] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Load 3 months around current view for context
    const from = startOfMonth(prevYM(ym));
    const to = endOfMonth(nextYM(ym));
    try {
      const data = await fetchGaps(from, to);
      setRecorded(data.recorded);
      setGaps(data.gaps.filter(d => d <= today)); // only count past gaps
    } finally {
      setLoading(false);
    }
  }, [ym, today]);

  useEffect(() => { load(); }, [load]);

  const isCurrentMonth = ym === currentYM();

  // Summary stats for visible month only
  const monthDays = daysInMonth(ym).filter(d => d <= today);
  const monthRecorded = monthDays.filter(d => recorded.has(d)).length;
  const monthGaps = monthDays.filter(d => gaps.includes(d)).length;
  const pct = monthDays.length > 0 ? Math.round((monthRecorded / monthDays.length) * 100) : 100;

  // Recent gaps (last 7 days)
  const recentGaps = Array.from({ length: 7 }, (_, i) => offsetDate(today, -(6 - i))).filter(d =>
    gaps.includes(d)
  );

  return (
    <AppLayout title="Food Safety Records">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Top summary banner */}
        {!loading && (
          <div className={`rounded-xl border p-4 flex items-center gap-4 ${
            monthGaps === 0
              ? "bg-emerald-50 border-emerald-200"
              : "bg-amber-50 border-amber-200"
          }`}>
            <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
              monthGaps === 0 ? "bg-emerald-100" : "bg-amber-100"
            }`}>
              {monthGaps === 0
                ? <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                : <AlertCircle className="w-5 h-5 text-amber-600" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className={`font-semibold text-sm ${monthGaps === 0 ? "text-emerald-800" : "text-amber-800"}`}>
                {monthGaps === 0
                  ? "All days covered this month"
                  : `${monthGaps} day${monthGaps !== 1 ? "s" : ""} missing this month`}
              </p>
              <p className={`text-xs mt-0.5 ${monthGaps === 0 ? "text-emerald-700" : "text-amber-700"}`}>
                {monthRecorded} of {monthDays.length} days recorded · {pct}% complete
              </p>
            </div>
          </div>
        )}

        {/* Calendar card */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {/* Calendar header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setYm(prevYM)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium text-sm">{monthLabel(ym)}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={isCurrentMonth}
              onClick={() => setYm(nextYM)}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>

          <div className="p-5">
            {loading ? (
              <div className="flex justify-center py-10 text-muted-foreground text-sm">Loading…</div>
            ) : (
              <CalendarGrid ym={ym} recorded={recorded} gaps={gaps} today={today} />
            )}
          </div>

          {/* Legend */}
          <div className="px-5 pb-4 flex items-center gap-5 text-xs text-muted-foreground border-t border-border pt-3">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300" />
              Recorded
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-red-100 border border-red-300" />
              Missing
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-muted/50 border border-border" />
              Future
            </div>
          </div>
        </div>

        {/* Recent gaps list */}
        {recentGaps.length > 0 && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-500" />
              <span className="font-medium text-sm">Missing in the last 7 days</span>
            </div>
            <div className="divide-y divide-border">
              {recentGaps.map((date) => (
                <div key={date} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <span className="text-sm font-medium">
                      {new Date(date).toLocaleDateString("en-GB", {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })}
                    </span>
                    {date === today && (
                      <Badge variant="outline" className="ml-2 text-xs border-amber-300 text-amber-700">Today</Badge>
                    )}
                  </div>
                  <Badge variant="outline" className="text-xs border-red-200 text-red-600 bg-red-50">
                    No record
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* All clear state for recent 7 days */}
        {!loading && recentGaps.length === 0 && (
          <div className="text-center py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-400" />
            No missing records in the last 7 days.
          </div>
        )}
      </div>
    </AppLayout>
  );
}
