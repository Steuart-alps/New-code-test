import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout";
import { useGetSettings } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { useToast } from "@/hooks/use-toast";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Settings2, Mail, Send, Bell, CheckCircle2, Globe, RefreshCw, Trash2, Copy, AlertCircle, ExternalLink } from "lucide-react";

interface DomainRecord {
  record?: string;
  name: string;
  type: string;
  value: string;
  ttl?: string | number;
  priority?: number;
  status?: string;
}

interface DomainState {
  configured: boolean;
  domainId?: string;
  domainName: string | null;
  status: string | null;
  records: DomainRecord[];
}

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");

async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === "verified") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold">
        <CheckCircle2 className="w-3.5 h-3.5" /> Verified
      </span>
    );
  }
  if (status === "failed" || status === "temporary_failure") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-50 text-rose-700 border border-rose-200 text-xs font-semibold">
        <AlertCircle className="w-3.5 h-3.5" /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 border border-amber-200 text-xs font-semibold">
      <RefreshCw className="w-3.5 h-3.5" /> Pending verification
    </span>
  );
}

function SenderDomainCard() {
  const { toast } = useToast();
  const [state, setState] = useState<DomainState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [domainInput, setDomainInput] = useState("");

  const refresh = async () => {
    try {
      const data = await apiFetch<DomainState>("/email-domain");
      setState(data);
    } catch (err: any) {
      toast({ title: "Couldn't load domain", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const register = async () => {
    if (!domainInput.trim()) return;
    setBusy(true);
    try {
      const data = await apiFetch<DomainState>("/email-domain", {
        method: "POST",
        body: JSON.stringify({ name: domainInput.trim() }),
      });
      setState(data);
      setDomainInput("");
      toast({ title: "Domain added", description: "Add the DNS records below to your DNS provider, then verify." });
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    try {
      const data = await apiFetch<DomainState>("/email-domain/verify", { method: "POST" });
      setState(data);
      if (data.status === "verified") {
        toast({ title: "Domain verified!", description: "You can now send emails from this domain." });
      } else {
        toast({ title: "Still pending", description: "DNS records may take up to 24 hours to propagate. Try again shortly." });
      }
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const removeDomain = async () => {
    if (!confirm("Remove this sender domain? Emails will fall back to the default sender.")) return;
    setBusy(true);
    try {
      const data = await apiFetch<DomainState>("/email-domain", { method: "DELETE" });
      setState(data);
      toast({ title: "Domain removed" });
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value);
    toast({ title: "Copied to clipboard" });
  };

  return (
    <Card className="shadow-lg border-border/50 bg-card mb-6">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <Globe className="w-5 h-5 text-emerald-600" />
          <CardTitle className="font-display">Sender Domain</CardTitle>
        </div>
        <CardDescription>
          Send emails from your own verified domain (e.g. <code className="text-xs bg-muted px-1.5 py-0.5 rounded">noreply@yourcompany.co.uk</code>) instead of the default sender.
          You'll need access to your domain's DNS settings.{" "}
          <a
            href="https://resend.com/docs/dashboard/domains/introduction"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-primary hover:underline font-medium"
          >
            Domain setup guide <ExternalLink className="w-3 h-3" />
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-5">
        {loading ? (
          <div className="py-6 flex justify-center"><div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : !state?.configured ? (
          <div className="space-y-3">
            <Label>Your sending domain</Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="yourcompany.co.uk"
                className="flex-1"
              />
              <Button onClick={register} disabled={busy || !domainInput.trim()}>
                {busy ? "Adding..." : "Add Domain"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter the root domain (without <code>www</code> or <code>@</code>). After adding it you'll receive DNS records to copy into your domain provider.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <div className="font-semibold font-display text-lg">{state.domainName}</div>
                <div className="mt-1"><StatusBadge status={state.status} /></div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={verify} disabled={busy}>
                  <RefreshCw className={`w-4 h-4 mr-1.5 ${busy ? "animate-spin" : ""}`} /> Check status
                </Button>
                <Button variant="ghost" size="sm" onClick={removeDomain} disabled={busy} className="text-destructive hover:bg-destructive/10">
                  <Trash2 className="w-4 h-4 mr-1.5" /> Remove
                </Button>
              </div>
            </div>

            {state.status !== "verified" && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5"><AlertCircle className="w-4 h-4" /> Action required</div>
                Add the records below to your domain's DNS settings, then click <strong>Check status</strong>. DNS changes can take up to 24 hours to propagate.
              </div>
            )}

            {state.records.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold">Type</th>
                      <th className="px-4 py-2 text-left font-semibold">Name / Host</th>
                      <th className="px-4 py-2 text-left font-semibold">Value</th>
                      <th className="px-4 py-2 text-left font-semibold">TTL</th>
                      <th className="px-4 py-2 text-left font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {state.records.map((r, i) => (
                      <tr key={i} className="align-top">
                        <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{r.type}</td>
                        <td className="px-4 py-3 font-mono text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="break-all">{r.name}</span>
                            <button onClick={() => copy(r.name)} className="opacity-50 hover:opacity-100"><Copy className="w-3 h-3" /></button>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="break-all">{r.value}{r.priority ? ` (priority ${r.priority})` : ""}</span>
                            <button onClick={() => copy(r.value)} className="opacity-50 hover:opacity-100 flex-shrink-0"><Copy className="w-3 h-3" /></button>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{String(r.ttl ?? "Auto")}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {r.status === "verified" ? (
                            <span className="text-emerald-700 inline-flex items-center gap-1 text-xs font-semibold"><CheckCircle2 className="w-3 h-3" /> OK</span>
                          ) : (
                            <span className="text-amber-700 text-xs font-semibold">Pending</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {state.status === "verified" && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Domain verified</div>
                Set the <em>From Email Address</em> below to anything ending in <strong>@{state.domainName}</strong> and emails will be sent from your domain.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetSettings();
  const { updateSettings, triggerTestEmail } = useAppMutations();

  const [formData, setFormData] = useState({
    companyName: "",
    defaultLeadTimeDays: "30",
    maintenanceEmail: "",
    additionalReminderEmails: "",
    notifyClientAdmins: "false",
    smtpFrom: "",
    smtpFromName: "",
  });

  const [testEmail, setTestEmail] = useState("");

  useEffect(() => {
    if (settings) {
      setFormData({
        companyName: settings.companyName || "",
        defaultLeadTimeDays: settings.defaultLeadTimeDays || "30",
        maintenanceEmail: (settings as any).maintenanceEmail || "",
        additionalReminderEmails: (settings as any).additionalReminderEmails || "",
        notifyClientAdmins: (settings as any).notifyClientAdmins || "false",
        smtpFrom: settings.smtpFrom || "",
        smtpFromName: settings.smtpFromName || "",
      });
    }
  }, [settings]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateSettings.mutateAsync({ data: formData });
  };

  const handleTestEmail = async () => {
    if (!testEmail) return;
    await triggerTestEmail.mutateAsync({ data: { to: testEmail } });
  };

  if (isLoading) return <AppLayout title="Settings"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mt-10" /></AppLayout>;

  return (
    <AppLayout title="System Settings">
      <div className="max-w-4xl space-y-6">
        <form onSubmit={handleSave}>
          <Card className="shadow-lg border-border/50 bg-card mb-6">
            <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
              <div className="flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-primary" />
                <CardTitle className="font-display">General Preferences</CardTitle>
              </div>
              <CardDescription>Global configuration for the compliance tracker.</CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>Company Name</Label>
                  <Input name="companyName" value={formData.companyName} onChange={handleChange} placeholder="Acme Corp" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>Default Reminder Lead Time (Days)</Label>
                  <p className="text-xs text-muted-foreground">Reminders sent this many days before a check is due. Default: 30 days.</p>
                  <Input type="number" name="defaultLeadTimeDays" value={formData.defaultLeadTimeDays} onChange={handleChange} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-lg border-border/50 bg-card mb-6">
            <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
              <div className="flex items-center gap-2">
                <Bell className="w-5 h-5 text-amber-500" />
                <CardTitle className="font-display">Reminder Notifications</CardTitle>
              </div>
              <CardDescription>
                Reminders are sent automatically to contractors every day at 8am when a compliance check enters its lead-time window.
                You can also copy in a maintenance contact on every reminder email.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-5">
              <div className="space-y-1.5">
                <Label>Maintenance / Office CC Emails</Label>
                <p className="text-xs text-muted-foreground">
                  These addresses will be copied on every contractor reminder email. Separate multiple addresses with a comma.
                </p>
                <Input
                  name="maintenanceEmail"
                  value={formData.maintenanceEmail}
                  onChange={handleChange}
                  placeholder="maintenance@yourcompany.com, office@yourcompany.com"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Additional Recipients</Label>
                <p className="text-xs text-muted-foreground">
                  Optional extra addresses to copy on reminders — useful for site managers, directors, or external auditors. Separate with commas, semicolons, or new lines.
                </p>
                <Textarea
                  name="additionalReminderEmails"
                  value={formData.additionalReminderEmails}
                  onChange={handleChange}
                  rows={2}
                  placeholder="director@yourcompany.com, sitemanager@yourcompany.com"
                />
              </div>

              <label className="flex items-start gap-2.5 rounded-md border border-border bg-muted/30 p-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                  checked={formData.notifyClientAdmins === "true"}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, notifyClientAdmins: e.target.checked ? "true" : "false" }))
                  }
                />
                <span className="text-sm">
                  <span className="font-medium">Always copy account admins on every reminder</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    When ticked, every reminder email is automatically copied to the email address of every active admin user on this account — including yours when you trigger a manual send.
                  </span>
                </span>
              </label>
            </CardContent>
          </Card>

          <SenderDomainCard />

          <Card className="shadow-lg border-border/50 bg-card">
            <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-indigo-500" />
                <CardTitle className="font-display">Email Settings</CardTitle>
              </div>
              <CardDescription>
                Configure the sender name and address for outgoing emails. All emails are delivered via Resend.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700">
                <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                Resend is configured as your email provider. No additional credentials are required.
              </div>
              <div className="grid grid-cols-2 gap-6 pt-2">
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>From Email Address</Label>
                  <p className="text-xs text-muted-foreground">Must be a verified sender domain in your Resend account.</p>
                  <Input name="smtpFrom" value={formData.smtpFrom} onChange={handleChange} placeholder="compliance@yourcompany.com" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>From Name</Label>
                  <Input name="smtpFromName" value={formData.smtpFromName} onChange={handleChange} placeholder="Acme Compliance Team" />
                </div>
              </div>
            </CardContent>
            <CardFooter className="bg-muted/10 border-t border-border/50 p-6 flex justify-between items-center">
              <div className="flex items-center gap-3">
                <Input
                  placeholder="Test recipient email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="w-64"
                />
                <Button type="button" variant="secondary" onClick={handleTestEmail} disabled={triggerTestEmail.isPending || !testEmail}>
                  <Send className="w-4 h-4 mr-2" /> {triggerTestEmail.isPending ? "Sending..." : "Send Test"}
                </Button>
              </div>
              <Button type="submit" disabled={updateSettings.isPending} className="shadow-lg shadow-primary/20">
                {updateSettings.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </CardFooter>
          </Card>
        </form>
      </div>
    </AppLayout>
  );
}
