import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { KeyRound, Loader2, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";

interface StaffMember {
  id: number;
  name: string;
  role?: string | null;
  job_title?: string | null;
  has_pin?: boolean;
  pin_set?: boolean;
  active?: boolean;
}

const hasPin = (member: StaffMember) => member.has_pin === true || member.pin_set === true;
const TOKEN_STORAGE_KEY = "staff-kiosk-token";

/** Public kiosk links carry an opaque bearer token, never a client identifier. */
function getKioskToken() {
  // Fragments are not sent in HTTP requests or referrers. Read the token from
  // there once, persist it for refreshes, and remove the fragment immediately.
  const fromUrl = new URLSearchParams(window.location.hash.slice(1)).get("kiosk_token");
  if (window.location.hash) {
    window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
  }
  const token = fromUrl || window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  if (fromUrl) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  }
  return token;
}

function KioskShell({ children }: { children: ReactNode }) {
  return <main className="min-h-screen bg-muted/30 flex items-center justify-center p-4">
    <section className="w-full max-w-lg rounded-xl border bg-background shadow-sm p-6 sm:p-8">{children}</section>
  </main>;
}

function useStaffList() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const token = getKioskToken();
      if (!token) throw new Error("This kiosk link needs a valid kiosk token.");
      // /staff/public is the kiosk discovery contract. Do not use /staff here:
      // that route is intentionally authenticated manager API.
      const response = await apiFetch("/staff/public", { headers: { "x-kiosk-token": token } });
      if (!response.ok) throw new Error("Unable to load the active staff list.");
      setStaff((await response.json()) as StaffMember[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the active staff list.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { staff, loading, error, reload };
}

export function StaffSetPinPage() {
  const [token] = useState(() => {
    // Enrollment credentials arrive in the fragment so they are never sent in
    // HTTP requests or referrers. Persist them for refreshes, then remove the
    // fragment before the page can make any API request.
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fromUrl = fragment.get("enrollment_token");
    const id = fragment.get("staff_id");
    if (fromUrl && /^[A-Za-z0-9_-]{32,128}$/.test(fromUrl)) {
      window.sessionStorage.setItem("staff-pin-enrollment-token", fromUrl);
      if (id) window.sessionStorage.setItem("staff-pin-enrollment-staff-id", id);
    }
    if (window.location.hash) {
      window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
    }
    return { token: fromUrl || window.sessionStorage.getItem("staff-pin-enrollment-token"), staffId: id || window.sessionStorage.getItem("staff-pin-enrollment-staff-id") };
  });
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function savePin() {
    if (!token.staffId || !token.token || !/^\d{4,6}$/.test(pin) || pin !== confirm) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await apiFetch(`/staff/${token.staffId}/set-pin`, {
        method: "POST", body: JSON.stringify({ pin, enrollment_token: token.token }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "PIN could not be saved.");
      setMessage("PIN saved. You can now use it at the kiosk.");
      setPin(""); setConfirm("");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "PIN could not be saved.");
    } finally { setSaving(false); }
  }

  return <KioskShell>
    <div className="text-center mb-6">
      <KeyRound className="mx-auto h-10 w-10 text-primary mb-3" />
      <h1 className="text-2xl font-display font-bold">Set your kiosk PIN</h1>
      <p className="text-sm text-muted-foreground mt-1">Choose your name, then create a 4–6 digit PIN.</p>
    </div>
    {!token.staffId || !token.token && <div className="text-sm text-destructive mb-4" data-testid="status-staff-error">Use the one-time setup link issued by your manager.</div>}
    {message && <div className="rounded-md bg-muted p-3 text-sm mb-4" data-testid="status-pin-message">{message}</div>}
    <div className="space-y-4">
      <p className="font-medium">Create your staff PIN</p>
      <Input autoFocus type="password" inputMode="numeric" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ""))} placeholder="New PIN (4–6 digits)" data-testid="input-new-pin" />
      <Input type="password" inputMode="numeric" maxLength={6} value={confirm} onChange={e => setConfirm(e.target.value.replace(/\D/g, ""))} placeholder="Confirm PIN" data-testid="input-confirm-pin" />
      {pin && !/^\d{4,6}$/.test(pin) && <p className="text-xs text-destructive">PIN must contain 4–6 digits.</p>}
      {confirm && pin !== confirm && <p className="text-xs text-destructive">PINs do not match.</p>}
      <Button className="w-full" onClick={savePin} disabled={saving || !token.staffId || !token.token || !/^\d{4,6}$/.test(pin) || pin !== confirm} data-testid="button-save-pin">{saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Save PIN</Button>
    </div>
  </KioskShell>;
}

export default function KioskPage() {
  const { staff, loading, error, reload } = useStaffList();
  const [selected, setSelected] = useState<StaffMember | null>(null);
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [capability, setCapability] = useState<string | null>(null);
  const [allowedAction, setAllowedAction] = useState<{ type: string; label: string; payload?: unknown } | null>(null);
  const reset = useCallback(() => { setSelected(null); setPin(""); setMessage(""); setBusy(false); setCapability(null); setAllowedAction(null); }, []);
  useEffect(() => { const timer = window.setTimeout(reset, 120000); return () => window.clearTimeout(timer); }, [selected, pin, message, reset]);

  async function continueToAction() {
    if (!selected) return;
    if (!hasPin(selected)) {
      setMessage("A manager must issue a PIN setup link before you can start a shift.");
      return;
    }
    setBusy(true); setMessage("");
    try {
      const token = getKioskToken();
      if (!token) throw new Error("This kiosk link needs a valid kiosk token.");
      const response = await apiFetch("/staff/verify-pin", {
        method: "POST",
        headers: { "x-kiosk-token": token },
        body: JSON.stringify({ staff_member_id: selected.id, ...(pin ? { pin } : {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "That PIN was not accepted.");
      const nextCapability = data.capability;
      const nextAction = data.action;
      if (typeof nextCapability !== "string" || !nextAction?.label || typeof nextAction.type !== "string") throw new Error("No kiosk action was provided.");
      setCapability(nextCapability);
      setAllowedAction({ label: "Start shift", type: nextAction.type, payload: nextAction.payload });
    } catch (e) { setMessage(e instanceof Error ? e.message : "Unable to verify PIN."); setBusy(false); }
  }

  async function submitAllowedAction() {
    if (!capability || !allowedAction) return;
    setBusy(true); setMessage("");
    try {
      const response = await apiFetch("/staff/kiosk-action", {
        method: "POST",
        body: JSON.stringify({ capability, action_type: allowedAction.type, payload: allowedAction.payload ?? {} }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The action could not be completed.");
      setMessage(data.message || "Completed successfully.");
      window.setTimeout(reset, 1500);
    } catch (e) { setMessage(e instanceof Error ? e.message : "The action could not be completed."); setBusy(false); }
  }

  return <KioskShell>
    <div className="text-center mb-6"><ShieldCheck className="mx-auto h-10 w-10 text-primary mb-3" /><h1 className="text-2xl font-display font-bold">Staff kiosk</h1><p className="text-sm text-muted-foreground mt-1">Choose your name to complete the kiosk action.</p></div>
    {loading && <Loader2 className="mx-auto h-5 w-5 animate-spin" />}
    {error && <div className="text-sm text-destructive mb-4" data-testid="status-kiosk-error">{error}<Button variant="link" onClick={reload}>Try again</Button></div>}
    {!selected ? <div className="grid gap-2">{staff.map(member => <Button key={member.id} variant="outline" className="justify-start h-12" data-testid={`button-kiosk-staff-${member.id}`} onClick={() => { setSelected(member); setMessage(hasPin(member) ? "" : "A manager must issue a PIN setup link before you can start a shift."); }}><Users className="h-4 w-4 mr-3" />{member.name}</Button>)}</div> :
      <div className="space-y-4"><p className="font-medium text-center">Welcome, {selected.name}</p>{!capability && hasPin(selected) && <Input autoFocus type="password" inputMode="numeric" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ""))} placeholder="Enter your PIN" data-testid="input-kiosk-pin" />}{message && <p className={capability ? "text-sm text-green-700 text-center" : "text-sm text-destructive"} data-testid="status-kiosk-message">{message}</p>}{!capability ? <Button className="w-full" onClick={continueToAction} disabled={busy || !hasPin(selected) || !pin} data-testid="button-kiosk-continue">{busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Continue</Button> : <Button className="w-full" onClick={submitAllowedAction} disabled={busy} data-testid="button-kiosk-action">{busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}{allowedAction?.label}</Button>}<Button variant="outline" className="w-full" onClick={reset} disabled={busy}>Start over</Button></div>}
    <p className="text-center text-xs text-muted-foreground mt-6">For shared devices. This screen resets after inactivity.</p>
  </KioskShell>;
}