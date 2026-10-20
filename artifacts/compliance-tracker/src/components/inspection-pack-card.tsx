import { useEffect, useRef, useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { downloadBlob } from "@/lib/download";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Site { id: number; name: string }

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Inclusive period ending yesterday's month end or today, for the quick picks. */
function period(kind: "last-month" | "last-3-months" | "last-12-months") {
  const today = new Date();
  if (kind === "last-month") {
    return {
      from: localDate(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      to: localDate(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
  }
  const months = kind === "last-3-months" ? 3 : 12;
  const from = new Date(today.getFullYear(), today.getMonth() - months, today.getDate() + 1);
  return { from: localDate(from), to: localDate(today) };
}

/** True when `to` is within 12 months of `from` (the server's limit). */
function withinTwelveMonths(from: string, to: string) {
  const [year, month, day] = from.split("-").map(Number);
  // Same end-of-month clamp as the server (29 Feb + 12 months = 28 Feb).
  const lastDay = new Date(year + 1, month, 0).getDate();
  return to < localDate(new Date(year + 1, month - 1, Math.min(day, lastDay)));
}

/**
 * One-click inspection pack: a PDF of one site (or every site) for a date
 * range, to hand to an EHO, fire officer or insurer. Read-only, so every role
 * can download it; the server limits it to the sites the user can see.
 */
export function InspectionPackCard() {
  const { user, activeClientId } = useAuth();
  const api = useActiveClientApi();
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState("all");
  const [{ from, to }, setRange] = useState(() => period("last-month"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setSiteId("all"); setError(""); setBusy(false);
    api("/sites")
      .then(async (response) => (response.ok ? await response.json() as Site[] : []))
      .then((rows) => { if (current === generation.current) setSites(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (current === generation.current) setSites([]); });
  }, [api, activeClientId, user?.id]);

  const rangeError = !from || !to ? "Choose a start and end date."
    : from > to ? "The start date must not be after the end date."
      : !withinTwelveMonths(from, to) ? "Choose a period of 12 months or less." : "";

  async function download() {
    if (rangeError) return;
    const current = generation.current;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ from, to });
      if (siteId !== "all") params.set("siteId", siteId);
      const response = await api(`/reports/inspection-pack?${params}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || "The inspection pack could not be created");
      }
      if (!response.headers.get("content-type")?.includes("application/pdf")) {
        throw new Error("The server did not return a PDF");
      }
      const blob = await response.blob();
      if (current !== generation.current) return;
      const name = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1]
        ?? `inspection-pack-${from}-to-${to}.pdf`;
      downloadBlob(blob, name);
    } catch (problem) {
      if (current === generation.current) setError(problem instanceof Error ? problem.message : "Download failed");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  return (
    <Card className="mb-6 print:hidden" data-testid="inspection-pack-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileDown className="h-4 w-4" /> Inspection pack
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          One PDF to hand to an environmental health officer, fire officer or insurer: compliance checks,
          check logs, out-of-range readings, incidents (without personal details), contractor and training
          expiry dates for the site and period you choose.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-1">
            <Label htmlFor="inspection-pack-site">Site</Label>
            <Select value={siteId} onValueChange={setSiteId} disabled={busy}>
              <SelectTrigger id="inspection-pack-site"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sites</SelectItem>
                {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="inspection-pack-from">From</Label>
            <Input id="inspection-pack-from" type="date" value={from} disabled={busy}
              onChange={event => setRange(range => ({ ...range, from: event.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="inspection-pack-to">To</Label>
            <Input id="inspection-pack-to" type="date" value={to} disabled={busy}
              onChange={event => setRange(range => ({ ...range, to: event.target.value }))} />
          </div>
          <Button onClick={() => void download()} disabled={busy || !!rangeError} className="sm:col-span-2 lg:col-span-1">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
            {busy ? "Preparing pack…" : "Download PDF"}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {([["last-month", "Last month"], ["last-3-months", "Last 3 months"], ["last-12-months", "Last 12 months"]] as const)
            .map(([kind, text]) => (
              <button key={kind} type="button" disabled={busy} onClick={() => setRange(period(kind))}
                className="text-primary underline-offset-2 hover:underline disabled:opacity-50">
                {text}
              </button>
            ))}
        </div>
        {rangeError && <p role="alert" className="mt-2 text-sm text-destructive">{rangeError}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error} — adjust the selection or try again.</p>}
      </CardContent>
    </Card>
  );
}
