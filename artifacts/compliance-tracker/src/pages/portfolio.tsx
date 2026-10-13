import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { format } from "date-fns";
import { AlertTriangle, ArrowRight, Building2, ClipboardList, ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { API_BASE, apiFetch, getApiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SubscriptionState = "subscribed" | "past_due" | "cancelling" | "trial" | "trial_ended" | "cancelled" | "unknown";

interface PortfolioBusiness {
  id: number;
  name: string;
  active: boolean;
  sites: number;
  overdueChecks: number;
  openActions: number;
  overdueActions: number;
  lastActivityAt: string | null;
  subscription: SubscriptionState;
  trialEndsAt: string | null;
}

interface Branding { practiceName: string | null; hasLogo: boolean; updatedAt: string | null }

const ukDate = (value: string | null) => value ? format(new Date(value), "d MMM yyyy") : "—";

function subscriptionLabel(business: PortfolioBusiness): { text: string; tone: "good" | "warn" | "bad" | "muted" } {
  switch (business.subscription) {
    case "subscribed": return { text: "Subscribed", tone: "good" };
    case "past_due": return { text: "Payment overdue", tone: "bad" };
    case "cancelling": return { text: "Cancelling", tone: "warn" };
    case "trial": return { text: business.trialEndsAt ? `Trial until ${ukDate(business.trialEndsAt)}` : "Trial", tone: "warn" };
    case "trial_ended": return { text: "Trial ended", tone: "bad" };
    case "cancelled": return { text: "Cancelled", tone: "muted" };
    default: return { text: "Not known", tone: "muted" };
  }
}

const TONE: Record<"good" | "warn" | "bad" | "muted", string> = {
  good: "bg-emerald-50 text-emerald-800 border-emerald-200",
  warn: "bg-amber-50 text-amber-900 border-amber-200",
  bad: "bg-rose-50 text-rose-800 border-rose-200",
  muted: "bg-muted text-muted-foreground border-border",
};

function SubscriptionBadge({ business }: { business: PortfolioBusiness }) {
  const label = subscriptionLabel(business);
  return <span className={cn("inline-block whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs font-medium", TONE[label.tone])}>{label.text}</span>;
}

function Count({ value, alert }: { value: number; alert?: boolean }) {
  return <span className={cn("font-semibold tabular-nums", alert && value > 0 ? "text-rose-700" : value === 0 ? "text-muted-foreground" : "")}>{value}</span>;
}

function BrandingCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [practiceName, setPracticeName] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const branding = useQuery<Branding>({
    queryKey: ["consultant-branding"],
    queryFn: async () => {
      const response = await apiFetch("/consultant-branding");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load your branding"));
      return response.json();
    },
  });
  useEffect(() => { setPracticeName(branding.data?.practiceName ?? ""); }, [branding.data?.practiceName]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["consultant-branding"] });

  async function saveName() {
    setSaving(true);
    try {
      const response = await apiFetch("/consultant-branding", { method: "PUT", body: JSON.stringify({ practiceName: practiceName.trim() || null }) });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not save the practice name"));
      toast({ title: "Practice name saved" });
      await refresh();
    } catch (err) {
      toast({ title: "Not saved", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(file: File) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast({ title: "PNG, JPEG or WebP only", variant: "destructive" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Logo too large", description: "Use an image of 2 MB or less.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const requested = await apiFetch("/consultant-branding/logo/request-url", { method: "POST", body: JSON.stringify({ contentType: file.type, size: file.size }) });
      if (!requested.ok) throw new Error(await getApiErrorMessage(requested, "Logo upload is unavailable"));
      const { uploadURL, objectPath } = await requested.json() as { uploadURL: string; objectPath: string };
      const put = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) throw new Error("Upload to storage failed");
      const saved = await apiFetch("/consultant-branding/logo", { method: "POST", body: JSON.stringify({ objectPath }) });
      if (!saved.ok) throw new Error(await getApiErrorMessage(saved, "The logo could not be checked"));
      toast({ title: "Logo updated" });
      await refresh();
    } catch (err) {
      toast({ title: "Logo not uploaded", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removeLogo() {
    const response = await apiFetch("/consultant-branding/logo", { method: "DELETE" });
    if (!response.ok) {
      toast({ title: "Logo not removed", description: await getApiErrorMessage(response, "Please try again."), variant: "destructive" });
      return;
    }
    await refresh();
  }

  const data = branding.data;
  return (
    <Card className="space-y-4 rounded-sm p-4 sm:p-5">
      <div>
        <h2 className="font-semibold">Your practice branding</h2>
        <p className="text-sm text-muted-foreground">Businesses you manage see “Managed by” with your practice name and logo.</p>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="practice-name">Practice name</Label>
          <Input id="practice-name" value={practiceName} maxLength={120} placeholder="e.g. Smith Safety Consulting" onChange={event => setPracticeName(event.target.value)} />
        </div>
        <Button onClick={saveName} disabled={saving || practiceName.trim() === (data?.practiceName ?? "")}>
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save name
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-sm border bg-muted/30">
          {data?.hasLogo
            ? <img src={`${API_BASE}/consultant-branding/logo?v=${encodeURIComponent(data.updatedAt ?? "")}`} alt="Practice logo" className="h-full w-full object-contain" />
            : <ImageIcon className="h-5 w-5 text-muted-foreground" />}
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadLogo(file); }} />
        <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}{data?.hasLogo ? "Replace logo" : "Upload logo"}
        </Button>
        {data?.hasLogo && <Button variant="ghost" size="sm" onClick={removeLogo}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove</Button>}
        <p className="w-full text-xs text-muted-foreground">PNG, JPEG or WebP, up to 2 MB. The logo only appears once a practice name is set.</p>
      </div>
    </Card>
  );
}

export default function PortfolioPage() {
  const { setActiveClientId, billingLocked } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();
  const fromLanding = new URLSearchParams(search).get("from") === "landing";
  const portfolio = useQuery<{ businesses: PortfolioBusiness[] }>({
    queryKey: ["portfolio"],
    queryFn: async () => {
      const response = await apiFetch("/portfolio");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load your businesses"));
      return response.json();
    },
  });
  const businesses = portfolio.data?.businesses ?? [];

  // The portfolio is the landing page only for consultants with two or more
  // businesses; everyone else continues to their dashboard.
  useEffect(() => {
    if (fromLanding && portfolio.data && businesses.length < 2) navigate("/dashboard", { replace: true });
  }, [fromLanding, portfolio.data, businesses.length, navigate]);

  function open(business: PortfolioBusiness) {
    setActiveClientId(business.id);
    navigate("/dashboard");
  }

  const totals = businesses.reduce((sum, business) => ({
    overdueChecks: sum.overdueChecks + business.overdueChecks,
    openActions: sum.openActions + business.openActions,
  }), { overdueChecks: 0, openActions: 0 });

  return (
    <AppLayout title="Portfolio">
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Every business you manage, with the items that need attention.
          </p>
          <Link href="/clients" className="text-sm font-medium text-primary underline-offset-2 hover:underline">Manage clients</Link>
        </div>

        {portfolio.isLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading your businesses…</div>
        ) : portfolio.isError ? (
          <p role="alert" className="py-12 text-center text-destructive">{portfolio.error instanceof Error ? portfolio.error.message : "Could not load your businesses."}</p>
        ) : businesses.length === 0 ? (
          <div className="rounded-sm border border-dashed p-12 text-center text-sm text-muted-foreground">
            No businesses yet. <Link href="/clients" className="font-medium text-primary underline">Add your first client</Link>.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card className="flex items-center gap-3 rounded-sm p-4"><Building2 className="h-5 w-5 text-primary" /><div><b className="text-xl">{businesses.length}</b><p className="text-xs text-muted-foreground">Businesses</p></div></Card>
              <Card className="flex items-center gap-3 rounded-sm p-4"><AlertTriangle className="h-5 w-5 text-rose-600" /><div><b className="text-xl">{totals.overdueChecks}</b><p className="text-xs text-muted-foreground">Overdue compliance checks</p></div></Card>
              <Card className="flex items-center gap-3 rounded-sm p-4"><ClipboardList className="h-5 w-5 text-amber-600" /><div><b className="text-xl">{totals.openActions}</b><p className="text-xs text-muted-foreground">Open actions</p></div></Card>
            </div>

            {/* Phones: one card per business */}
            <div className="space-y-3 md:hidden">
              {businesses.map(business => (
                <Card key={business.id} className="space-y-3 rounded-sm p-4" data-testid={`portfolio-card-${business.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-semibold">{business.name}</p>
                      <p className="text-xs text-muted-foreground">Last activity {ukDate(business.lastActivityAt)}</p>
                    </div>
                    <SubscriptionBadge business={business} />
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-xs">
                    <div><dt className="text-muted-foreground">Sites</dt><dd><Count value={business.sites} /></dd></div>
                    <div><dt className="text-muted-foreground">Overdue checks</dt><dd><Count value={business.overdueChecks} alert /></dd></div>
                    <div><dt className="text-muted-foreground">Open actions</dt><dd><Count value={business.openActions} alert={business.overdueActions > 0} />{business.overdueActions > 0 && <span className="text-rose-700"> ({business.overdueActions} overdue)</span>}</dd></div>
                  </dl>
                  <Button size="sm" className="w-full" onClick={() => open(business)}>Open <ArrowRight className="ml-1 h-3.5 w-3.5" /></Button>
                </Card>
              ))}
            </div>

            {/* Larger screens: one row per business */}
            <div className="hidden overflow-x-auto rounded-sm border md:block">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Business</th>
                    <th className="p-3 text-right font-medium">Sites</th>
                    <th className="p-3 text-right font-medium">Overdue checks</th>
                    <th className="p-3 text-right font-medium">Open actions</th>
                    <th className="p-3 font-medium">Last activity</th>
                    <th className="p-3 font-medium">Subscription</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody>
                  {businesses.map(business => (
                    <tr key={business.id} className="border-t" data-testid={`portfolio-row-${business.id}`}>
                      <td className="p-3 font-medium">{business.name}{!business.active && <span className="ml-2 text-xs font-normal text-muted-foreground">(inactive)</span>}</td>
                      <td className="p-3 text-right"><Count value={business.sites} /></td>
                      <td className="p-3 text-right"><Count value={business.overdueChecks} alert /></td>
                      <td className="p-3 text-right"><Count value={business.openActions} alert={business.overdueActions > 0} />{business.overdueActions > 0 && <span className="block text-xs text-rose-700">{business.overdueActions} overdue</span>}</td>
                      <td className="p-3 whitespace-nowrap">{ukDate(business.lastActivityAt)}</td>
                      <td className="p-3"><SubscriptionBadge business={business} /></td>
                      <td className="p-3 text-right"><Button size="sm" variant="outline" onClick={() => open(business)}>Open</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!billingLocked && <BrandingCard />}
      </div>
    </AppLayout>
  );
}
