import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CheckCircle2, GraduationCap, Loader2, LogOut, PenLine } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SignaturePad } from "@/components/signature-pad";

interface OwnRecord {
  id: number;
  record_type: "certificate" | "signoff" | "internal";
  training_type: string | null;
  document_title: string | null;
  provider: string | null;
  trainer: string | null;
  completed_date: string;
  expiry_date: string | null;
  notes: string | null;
  signed: boolean;
  site_name: string | null;
}

const KIND: Record<OwnRecord["record_type"], string> = {
  certificate: "Certificate",
  signoff: "Document sign-off",
  internal: "Internal training",
};

const ukDate = (value: string | null) => (value ? format(new Date(value), "d MMM yyyy") : null);

function RecordCard({ record }: { record: OwnRecord }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [signing, setSigning] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const title = record.training_type ?? record.document_title ?? "Training";
  const by = record.provider ?? record.trainer;
  const expired = record.expiry_date ? new Date(record.expiry_date).getTime() < Date.now() : false;

  async function sign() {
    if (!signature) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/train-track/my-records/${record.id}/sign`, { method: "POST", body: JSON.stringify({ signature }) });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Your signature wasn't saved"));
      toast({ title: "Signed off", description: title });
      setSigning(false);
      await queryClient.invalidateQueries({ queryKey: ["my-training"] });
    } catch (error) {
      toast({ title: "Not signed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3 rounded-sm p-4" data-testid={`my-training-${record.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{KIND[record.record_type]}</p>
          <p className="break-words font-semibold">{title}</p>
          <p className="text-sm text-muted-foreground">
            Completed {ukDate(record.completed_date)}{by ? ` · ${by}` : ""}{record.site_name ? ` · ${record.site_name}` : ""}
          </p>
          {record.expiry_date && (
            <p className={expired ? "text-sm font-medium text-rose-700" : "text-sm text-muted-foreground"}>
              {expired ? "Expired" : "Expires"} {ukDate(record.expiry_date)}
            </p>
          )}
          {record.notes && <p className="mt-1 whitespace-pre-wrap text-sm">{record.notes}</p>}
        </div>
        {record.signed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" />Signed</span>
        ) : !signing && (
          <Button size="sm" onClick={() => setSigning(true)}><PenLine className="mr-1.5 h-3.5 w-3.5" />Sign off</Button>
        )}
      </div>
      {signing && !record.signed && (
        <div className="space-y-3 border-t pt-3">
          <SignaturePad value={signature} onChange={setSignature} label="Your signature" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setSigning(false); setSignature(null); }}>Cancel</Button>
            <Button size="sm" onClick={sign} disabled={!signature || saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Confirm sign-off
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** A Viewer's whole app: their own training records, which they can sign off. */
export default function MyTrainingPage() {
  const { user, client, logout } = useAuth();
  const training = useQuery<{ linked: boolean; records: OwnRecord[] }>({
    queryKey: ["my-training"],
    queryFn: async () => {
      const response = await apiFetch("/train-track/my-records");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load your training records"));
      return response.json();
    },
  });
  const records = training.data?.records ?? [];
  const toSign = records.filter(record => !record.signed).length;

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-white px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{client?.name ?? "ComplyTrack"}</p>
          <h1 className="truncate font-display text-lg font-medium text-[#162D42]">My training</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={logout} className="shrink-0 text-destructive" data-testid="button-sign-out">
          <LogOut className="mr-1.5 h-4 w-4" />Sign out
        </Button>
      </header>
      <main className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          Hello {user?.name}. These are your training records. Sign off any that ask for your signature.
        </p>
        {training.isLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading your training…</div>
        ) : training.isError ? (
          <p role="alert" className="py-12 text-center text-destructive">{training.error instanceof Error ? training.error.message : "Could not load your training records."}</p>
        ) : !training.data?.linked ? (
          <Card className="rounded-sm p-6 text-center text-sm text-muted-foreground">
            <GraduationCap className="mx-auto mb-2 h-6 w-6" />
            Your account isn't linked to your name on the staff roster yet. Ask your manager to link it.
          </Card>
        ) : records.length === 0 ? (
          <Card className="rounded-sm p-6 text-center text-sm text-muted-foreground">No training records yet.</Card>
        ) : (
          <>
            {toSign > 0 && <p className="text-sm font-medium">{toSign === 1 ? "1 record is" : `${toSign} records are`} waiting for your signature.</p>}
            {records.map(record => <RecordCard key={record.id} record={record} />)}
          </>
        )}
      </main>
    </div>
  );
}
