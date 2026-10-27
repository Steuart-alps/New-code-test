import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { BUSINESS_TYPE_OPTIONS, onboardingRequest } from "@/lib/onboarding";

/** Settings: lets existing businesses set or change their business type. */
export function BusinessTypeCard() {
  const { user, activeClientId, refresh } = useAuth();
  const clientId = user?.role === "consultant" ? activeClientId : null;
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    onboardingRequest<{ businessType: string | null }>("/setup/state", clientId)
      .then((data) => { setValue(data.businessType ?? ""); setSaved(data.businessType ?? ""); })
      .catch(() => {});
  }, [clientId]);

  async function save() {
    setSaving(true);
    try {
      await onboardingRequest("/setup/business", clientId, { method: "PUT", body: JSON.stringify({ businessType: value || null }) });
      setSaved(value);
      void refresh();
      toast({ title: "Business type saved" });
    } catch (err) {
      toast({ title: "Could not save business type", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="shadow-lg border-border/50 bg-card mb-6">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <Building2 className="w-5 h-5 text-primary" />
          <CardTitle className="font-display font-bold">Business Type</CardTitle>
        </div>
        <CardDescription>Used to suggest modules and starter compliance checks, and for healthcare water temperature defaults.</CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-3">
        <div className="space-y-1.5 max-w-sm">
          <Label htmlFor="settings-business-type">Business type</Label>
          <select id="settings-business-type" value={value} onChange={(e) => setValue(e.target.value)}
            className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            <option value="">Not set</option>
            {BUSINESS_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button type="button" size="sm" onClick={save} disabled={saving || value === saved}>{saving ? "Saving…" : "Save business type"}</Button>
          <Link href="/setup" className="text-sm text-primary hover:underline">Review starter checks in setup</Link>
        </div>
      </CardContent>
    </Card>
  );
}
