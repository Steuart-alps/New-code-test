import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout";
import { useGetSettings } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Settings2, Mail, Send, Bell, CheckCircle2 } from "lucide-react";

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetSettings();
  const { updateSettings, triggerTestEmail } = useAppMutations();

  const [formData, setFormData] = useState({
    companyName: "",
    defaultLeadTimeDays: "30",
    maintenanceEmail: "",
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
        smtpFrom: settings.smtpFrom || "",
        smtpFromName: settings.smtpFromName || "",
      });
    }
  }, [settings]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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
            <CardContent className="p-6">
              <div className="space-y-1.5 max-w-md">
                <Label>Maintenance Contact CC Email</Label>
                <p className="text-xs text-muted-foreground">This address will be copied on every contractor reminder email.</p>
                <Input
                  name="maintenanceEmail"
                  type="email"
                  value={formData.maintenanceEmail}
                  onChange={handleChange}
                  placeholder="maintenance@yourcompany.com"
                />
              </div>
            </CardContent>
          </Card>

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
