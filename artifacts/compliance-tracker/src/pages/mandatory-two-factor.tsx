import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Download, KeyRound, ShieldCheck } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function MandatoryTwoFactorPage() {
  const { refresh, logout } = useAuth();
  const [, navigate] = useLocation();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [passkeySaving, setPasskeySaving] = useState(false);

  useEffect(() => {
    apiFetch("/auth/2fa/setup")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not start setup");
        setQrDataUrl(data.qrDataUrl);
        setSecret(data.secret);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not start setup"))
      .finally(() => setLoading(false));
  }, []);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const res = await apiFetch("/auth/2fa/enable", {
        method: "POST",
        body: JSON.stringify({ code: code.replace(/\s/g, "") }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "That code was not accepted");
      setRecoveryCodes(data.recoveryCodes ?? []);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "That code was not accepted");
      setCode("");
    } finally {
      setSaving(false);
    }
  }

  async function registerPasskey() {
    setError("");
    setPasskeySaving(true);
    try {
      const optionsRes = await apiFetch("/auth/passkeys/registration/options", { method: "POST", body: "{}" });
      const options = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(options.error ?? "Could not start passkey setup");
      const response = await startRegistration({ optionsJSON: options });
      const verifyRes = await apiFetch("/auth/passkeys/registration/verify", {
        method: "POST",
        body: JSON.stringify(response),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || !verifyData.setupComplete) throw new Error(verifyData.error ?? "Passkey setup did not complete");
      await refresh();
      navigate("/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Passkey setup failed");
    } finally {
      setPasskeySaving(false);
    }
  }

  async function leave() {
    await logout().catch(() => {});
    navigate("/login");
  }

  function downloadCodes() {
    const url = URL.createObjectURL(new Blob([
      `ComplyTrack recovery codes\n\n${recoveryCodes.join("\n")}\n\nEach code can be used once.`,
    ], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "complytrack-recovery-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (recoveryCodes.length > 0) {
    return (
      <div className="min-h-screen bg-[#F7F2E4] flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-white shadow-xl p-8 space-y-6">
          <div className="flex items-center gap-3 text-emerald-700">
            <ShieldCheck className="w-7 h-7" />
            <h1 className="text-2xl font-display text-[#162D42]">Two-factor authentication enabled</h1>
          </div>
          <div className="rounded-sm border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 space-y-3">
            <p className="font-semibold">Save these recovery codes now</p>
            <p>Each code works once if you lose access to your authenticator app. They will not be shown again.</p>
            <div className="grid grid-cols-2 gap-1 bg-white border border-amber-200 p-3">
              {recoveryCodes.map((value) => <code key={value} className="font-mono">{value}</code>)}
            </div>
            <Button variant="outline" onClick={downloadCodes}><Download className="w-4 h-4 mr-2" /> Download codes</Button>
          </div>
          <Button className="w-full" onClick={() => navigate("/dashboard")}>Continue to ComplyTrack</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F2E4] flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white shadow-xl p-8 space-y-6">
        <div className="flex items-center gap-3">
          <KeyRound className="w-7 h-7 text-primary" />
          <div>
            <h1 className="text-2xl font-display text-[#162D42]">Set up two-factor authentication</h1>
            <p className="text-sm text-muted-foreground mt-1">This is required before you can use ComplyTrack.</p>
          </div>
        </div>
        {loading ? <p className="text-sm text-muted-foreground">Preparing your secure setup…</p> : (
          <>
            <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
              <li>Open Google Authenticator, Authy, 1Password, or another TOTP authenticator.</li>
              <li>Scan the QR code, or enter the manual key if you are using the same device.</li>
              <li>Enter the six-digit code shown by the authenticator.</li>
            </ol>
            <div className="rounded-sm border border-primary/20 bg-primary/5 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <KeyRound className="w-5 h-5 text-primary mt-0.5" />
                <div>
                  <p className="font-semibold text-[#162D42]">Use a passkey instead</p>
                  <p className="text-sm text-muted-foreground">Passkeys use your device screen lock, fingerprint, or security key. You can add an authenticator app later.</p>
                </div>
              </div>
              <Button type="button" variant="outline" className="w-full" onClick={registerPasskey} disabled={passkeySaving}>
                {passkeySaving ? "Waiting for passkey…" : "Set up a passkey"}
              </Button>
            </div>
            {qrDataUrl && <div className="flex justify-center border p-4"><img src={qrDataUrl} alt="Authenticator setup QR code" className="w-48 h-48" /></div>}
            {secret && <p className="text-xs text-muted-foreground break-all">Manual key: <code className="font-mono text-foreground">{secret}</code></p>}
            <form onSubmit={enable} className="space-y-3">
              <Label htmlFor="mandatory-totp-code">Authentication code</Label>
              <Input id="mandatory-totp-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000 000" autoFocus />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={saving || code.length !== 6}>{saving ? "Verifying…" : "Confirm and continue"}</Button>
            </form>
          </>
        )}
        <Button type="button" variant="ghost" className="w-full" onClick={leave}>Sign out</Button>
      </div>
    </div>
  );
}