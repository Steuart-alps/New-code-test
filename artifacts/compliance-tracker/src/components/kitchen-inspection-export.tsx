import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function KitchenInspectionExport({ siteId }: { siteId: number | null }) {
  const { user, activeClientId } = useAuth();
  const [from, setFrom] = useState(() => { const date = new Date(); date.setDate(date.getDate() - 30); return localDate(date); });
  const [to, setTo] = useState(() => localDate(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; controller.current?.abort(); setBusy(false); setError("");
    return () => { generation.current++; controller.current?.abort(); };
  }, [siteId, activeClientId, user?.id]);
  if (user?.role !== "client_admin" && user?.role !== "consultant"
    && !(user?.role === "client_staff" && user.isDepartmentManager)) return null;
  async function download() {
    if (siteId === null || !from || !to || from > to) return;
    const current = generation.current;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ siteId: String(siteId), from, to });
      if (activeClientId != null) params.set("clientId", String(activeClientId));
      const response = await apiFetch(`/export/kitchen-register?${params}`, { signal: abort.signal });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error || "The inspection register could not be downloaded");
      }
      if (!response.headers.get("content-type")?.includes("application/zip")) throw new Error("The server did not return an inspection archive");
      const blob = await response.blob();
      if (current !== generation.current) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `kitchentrack-site-${siteId}-${from}-to-${to}.zip`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      if (current === generation.current) setError(problem instanceof Error ? problem.message : "Download failed");
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <section className="rounded border bg-card p-4 space-y-3">
    <h2 className="font-medium">KitchenTrack inspection register</h2>
    <p className="text-sm text-muted-foreground">Download this site’s temperatures, weekly reviews, probe checks, sign-offs, failures and corrective actions as a ZIP of CSV files. Dates are inclusive; later remediation is grouped with its original failed diary.</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">From<Input aria-label="Inspection start date" type="date" value={from} disabled={busy} onChange={e => setFrom(e.target.value)} /></label>
      <label className="text-sm">To<Input aria-label="Inspection end date" type="date" value={to} disabled={busy} onChange={e => setTo(e.target.value)} /></label>
      <Button disabled={busy || siteId === null || !from || !to || from > to} onClick={() => void download()}>{busy ? "Preparing register…" : "Download inspection register"}</Button>
    </div>
    {siteId === null && <p className="text-sm text-muted-foreground">Choose a site above to download its inspection register. Organisation-only legacy entries are not included.</p>}
    {from > to && <p role="alert" className="text-sm text-destructive">The start date must not be after the end date.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error} — adjust the selection or try downloading again.</p>}
  </section>;
}