import { useCallback, useEffect, useState } from "react";
import { BookOpen, CheckCircle2, Download, Loader2 } from "lucide-react";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { getDownloadErrorMessage } from "@/lib/download";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

interface MyDocument {
  id: number;
  title: string;
  category: string;
  description: string | null;
  file_name: string;
  site_name: string | null;
  department: string | null;
  acknowledged_at: string | null;
  signature: string | null;
}

interface MyDocuments {
  rosterLinked: boolean;
  pending: MyDocument[];
  completed: MyDocument[];
}

export function MyDocumentsView({ canAcknowledge }: { canAcknowledge: boolean }) {
  const { toast } = useToast();
  const [data, setData] = useState<MyDocuments | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const [signatures, setSignatures] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    const res = await apiFetch("/doc-track/acknowledgements/my");
    if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load your documents"));
    setData(await res.json() as MyDocuments);
    setError("");
  }, []);

  useEffect(() => {
    let mounted = true;
    apiFetch("/doc-track/acknowledgements/my")
      .then(async res => {
        if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load your documents"));
        const result = await res.json() as MyDocuments;
        if (mounted) setData(result);
      })
      .catch(err => { if (mounted) setError(err.message); });
    return () => { mounted = false; };
  }, []);

  async function openDocument(doc: MyDocument) {
    // Open in the click event so popup blockers do not discard the new tab
    // while the signed URL is being requested.
    const popup = window.open("", "_blank");
    setBusyId(doc.id);
    try {
      const res = await apiFetch(`/doc-track/documents/${doc.id}/download-url`);
      if (!res.ok) throw new Error(await getDownloadErrorMessage(res, "Could not open document"));
      const { downloadUrl } = await res.json() as { downloadUrl: string };
      if (popup) {
        popup.opener = null;
        popup.location.href = downloadUrl;
      } else {
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.click();
      }
      setOpened(prev => new Set(prev).add(doc.id));
    } catch (err) {
      popup?.close();
      toast({ title: "Could not open document", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function acknowledge(doc: MyDocument) {
    setBusyId(doc.id);
    try {
      const res = await apiFetch(`/doc-track/documents/${doc.id}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({ self: true, signature: signatures[doc.id]?.trim() || null }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not record acknowledgement"));
      await load();
      toast({ title: "Acknowledgement recorded", description: `"${doc.title}" is now in Completed.` });
    } catch (err) {
      toast({ title: "Acknowledgement failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  if (error) return (
    <Card><CardContent className="p-6 text-sm">
      <p role="alert" className="text-destructive">{error}</p>
      <Button className="mt-3" variant="outline" onClick={() => load().catch(err => setError(err.message))}>Try again</Button>
    </CardContent></Card>
  );
  if (!data) return <div className="flex items-center justify-center h-40"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!data.rosterLinked) return (
    <Card><CardContent className="p-6 text-sm">
      <p className="font-medium">Your staff record is not linked yet</p>
      <p className="mt-1 text-muted-foreground">Ask your account administrator to add an active staff roster entry with the same email address as your login. Once linked, your documents will appear here.</p>
    </CardContent></Card>
  );

  return <div className="space-y-8">
    <section aria-labelledby="my-pending-heading">
      <h2 id="my-pending-heading" className="flex items-center gap-2 text-lg font-semibold"><BookOpen className="h-5 w-5" /> Documents to read ({data.pending.length})</h2>
      {data.pending.length === 0 && <p className="mt-3 rounded-lg border p-5 text-sm text-muted-foreground">You’re all caught up. No documents need your acknowledgement right now.</p>}
      <div className="mt-3 space-y-3">
        {data.pending.map(doc => <Card key={doc.id}><CardContent className="p-5 space-y-3">
          <div>
            <h3 className="font-medium">{doc.title}</h3>
            <p className="text-xs text-muted-foreground">{[doc.category.replace(/_/g, " "), doc.site_name, doc.department].filter(Boolean).join(" · ")}</p>
            {doc.description && <p className="mt-2 text-sm text-muted-foreground">{doc.description}</p>}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button type="button" variant="outline" size="sm" disabled={busyId === doc.id} onClick={() => openDocument(doc)}>
              <Download className="mr-2 h-4 w-4" /> Open document
            </Button>
            {canAcknowledge && <>
              <Input className="sm:max-w-52" aria-label={`Optional typed signature for ${doc.title}`} placeholder="Signature (optional)" maxLength={300} value={signatures[doc.id] ?? ""} onChange={event => setSignatures(prev => ({ ...prev, [doc.id]: event.target.value }))} />
              <Button type="button" size="sm" disabled={!opened.has(doc.id) || busyId === doc.id} onClick={() => acknowledge(doc)}>
                {busyId === doc.id ? "Saving…" : "I’ve read this — acknowledge"}
              </Button>
            </>}
          </div>
          {canAcknowledge && !opened.has(doc.id) && <p className="text-xs text-muted-foreground">Open the document before acknowledging it.</p>}
        </CardContent></Card>)}
      </div>
    </section>
    <section aria-labelledby="my-completed-heading">
      <h2 id="my-completed-heading" className="flex items-center gap-2 text-lg font-semibold"><CheckCircle2 className="h-5 w-5" /> Completed ({data.completed.length})</h2>
      {data.completed.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No acknowledgements recorded yet.</p>}
      <div className="mt-3 space-y-2">
        {data.completed.map(doc => <div key={doc.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
          <div><p className="font-medium text-sm">{doc.title}</p><p className="text-xs text-muted-foreground">Acknowledged {doc.acknowledged_at ? new Date(doc.acknowledged_at).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—"}</p></div>
          <Button type="button" size="sm" variant="outline" disabled={busyId === doc.id} onClick={() => openDocument(doc)}>Open document</Button>
        </div>)}
      </div>
    </section>
  </div>;
}