import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout";
import { useGetSettings } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Settings2, Mail, Send } from "lucide-react";

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetSettings();
  const { updateSettings, triggerTestEmail } = useAppMutations();

  const [formData, setFormData] = useState({
    companyName: "",
    defaultLeadTimeDays: "7",
    smtpHost: "",
    smtpPort: "587",
    smtpUser: "",
    smtpPass: "",
    smtpFrom: "",
    smtpFromName: "",
  });

  const [testEmail, setTestEmail] = useState("");

  useEffect(() => {
    if (settings) {
      setFormData({
        companyName: settings.companyName || "",
        defaultLeadTimeDays: settings.defaultLeadTimeDays || "7",
        smtpHost: settings.smtpHost || "",
        smtpPort: settings.smtpPort || "587",
        smtpUser: settings.smtpUser || "",
        smtpPass: settings.smtpPass || "",
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
                  <Input type="number" name="defaultLeadTimeDays" value={formData.defaultLeadTimeDays} onChange={handleChange} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-lg border-border/50 bg-card">
            <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-indigo-500" />
                <CardTitle className="font-display">SMTP Email Configuration</CardTitle>
              </div>
              <CardDescription>Configure SMTP credentials to send automated reminders to contractors.</CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>SMTP Host</Label>
                  <Input name="smtpHost" value={formData.smtpHost} onChange={handleChange} placeholder="smtp.sendgrid.net" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>SMTP Port</Label>
                  <Input name="smtpPort" value={formData.smtpPort} onChange={handleChange} placeholder="587" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>SMTP Username</Label>
                  <Input name="smtpUser" value={formData.smtpUser} onChange={handleChange} placeholder="apikey" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>SMTP Password</Label>
                  <Input type="password" name="smtpPass" value={formData.smtpPass} onChange={handleChange} placeholder="••••••••" />
                </div>
                <div className="col-span-2">
                  <Separator className="my-2" />
                </div>
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label>From Email Address</Label>
                  <Input name="smtpFrom" value={formData.smtpFrom} onChange={handleChange} placeholder="compliance@acmecorp.com" />
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
