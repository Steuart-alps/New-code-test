import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type DeletionStatus = {
  eligible: boolean;
  request: {
    id: number;
    requested_at: string;
    earliest_deletion_at: string;
    notification_state: string;
    status: "pending" | "approved";
  } | null;
};

const formatDate = (date: string) => new Date(date).toLocaleDateString("en-GB", {
  day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London",
});

export function DataDeletionRequestCard() {
  const { user, activeClientId, billingLocked } = useAuth();
  const canAdmin = useCanAdmin();
  const [status, setStatus] = useState<{ clientId: number; value: DeletionStatus } | null>(null);
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const clientId = activeClientId;

  const refresh = async (selectedClientId: number) => {
    const res = await apiFetch(`/data-deletion/request?clientId=${selectedClientId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not load deletion request status");
    setStatus({ clientId: selectedClientId, value: data as DeletionStatus });
  };

  useEffect(() => {
    setError("");
    if (!canAdmin || clientId === null) return;
    let active = true;
    apiFetch(`/data-deletion/request?clientId=${clientId}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not load deletion request status");
        if (active) setStatus({ clientId, value: data as DeletionStatus });
      })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [canAdmin, clientId]);

  if (!canAdmin || clientId === null || status?.clientId !== clientId) return null;
  if (!status.value.eligible && !status.value.request) {
    return billingLocked ? (
      <Card><CardContent className="p-6 text-sm">Data deletion requests become available after a subscription is cancelled. Contact support if you need help with your account.</CardContent></Card>
    ) : null;
  }
  const request = status.value.request;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch("/data-deletion/request", {
        method: "POST",
        body: JSON.stringify({ clientId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not submit deletion request");
      setConfirmOpen(false);
      await refresh(clientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit deletion request");
      // The request may have been saved even if email delivery failed.
      await refresh(clientId).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-amber-300/70 bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg"><Trash2 className="h-5 w-5" /> Data deletion</CardTitle>
        <CardDescription>Request permanent removal of this client account’s records after cancellation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {request ? (
          <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
            <p className="font-semibold">{request.status === "approved" ? "Deletion request approved" : "Deletion request received"}</p>
            <p>Requested {formatDate(request.requested_at)}. Records will be retained for at least 30 days, until {formatDate(request.earliest_deletion_at)}. {request.status === "approved" ? "A reviewer approved this request; deletion is scheduled no earlier than that date, subject to legal holds. Once carried out, deletion is irreversible." : "An administrator will review legal retention requirements before any deletion. If approved, deletion is irreversible."}</p>
            {request.notification_state !== "sent" && <p className="mt-2">The administrator notification is still pending. Contact support if this does not resolve.</p>}
          </div>
        ) : (
          <>
            <p>No data will be deleted when you submit. We retain records for at least 30 days while an administrator reviews your request and any legal obligations. If deletion is approved after that window, it cannot be undone.</p>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(true)}>
              Request data deletion
            </Button>
          </>
        )}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>
      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!busy) setConfirmOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request permanent data deletion?</DialogTitle>
            <DialogDescription>
              This requests manual review; it does not delete anything now. Your records remain available for at least 30 days after the request, subject to account access and legal retention requirements. If deletion is approved and carried out, it is irreversible.
              {user?.role === "consultant" ? " You are submitting this on behalf of the selected client." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmOpen(false)}>Keep my data</Button>
            <Button variant="destructive" disabled={busy} onClick={submit}>{busy ? "Submitting…" : "Submit request"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}