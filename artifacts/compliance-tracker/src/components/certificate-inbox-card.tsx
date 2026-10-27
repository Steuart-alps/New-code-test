import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileText, Inbox, Loader2, Mail, ShieldAlert, Upload, X } from "lucide-react";
import {
  changeCertificateInboxAddress, dismissCertificateInboxItem, getGetCertificateInboxQueryKey, readCertificateInboxItem,
  useGetCertificateInbox, type CertificateInboxItem,
} from "@workspace/api-client-react";
import { CertificateReaderDialog } from "@/components/certificate-reader-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

const STATUS_LABEL: Record<CertificateInboxItem["status"], string> = {
  reading: "Reading…",
  ready: "Ready to check",
  held: "Unknown sender",
  message: "Message, no certificate",
};

function from(item: CertificateInboxItem): string {
  const who = item.contractorName ?? item.senderName ?? item.senderEmail ?? "Unknown sender";
  const when = new Date(item.receivedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${item.source === "upload" ? "Uploaded" : "Emailed"} by ${who} · ${when}`;
}

/** The business's certificate inbox, for owners and ALPS consultants (Compliance Checks page). */
export function useCertificateInbox(enabled = true) {
  return useGetCertificateInbox({
    query: {
      queryKey: getGetCertificateInboxQueryKey(),
      enabled,
      // While the AI is reading something, look again shortly.
      refetchInterval: (query) => query.state.data?.items.some((item) => item.status === "reading") ? 10_000 : false,
    },
  });
}

/**
 * "Certificates to confirm": certificates contractors emailed to the business's
 * certificate address or uploaded from the link in their emails. Each is
 * checked on the same screen as an uploaded certificate before it is saved.
 */
export function CertificateInboxCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inbox = useCertificateInbox();
  const [open, setOpen] = useState<CertificateInboxItem | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const items = inbox.data?.items ?? [];
  const address = inbox.data?.address ?? null;
  if (!inbox.data || (!items.length && !address)) return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetCertificateInboxQueryKey() });

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy this address", description: address });
    }
  }

  async function changeAddress() {
    if (!window.confirm("Give this business a new certificate address? The old one stops working, so anyone who has it will need the new one.")) return;
    try {
      await changeCertificateInboxAddress();
      await refresh();
      toast({ title: "New certificate address", description: "Contractor emails from now on show the new address." });
    } catch (err) {
      toast({ title: "The address was not changed", description: err instanceof Error ? err.message : "Please try again", variant: "destructive" });
    }
  }

  async function accept(item: CertificateInboxItem) {
    setBusyId(item.id);
    try {
      const read = await readCertificateInboxItem(item.id);
      await refresh();
      setOpen(read);
    } catch (err) {
      toast({ title: "Could not open it", description: err instanceof Error ? err.message : "Please try again", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(item: CertificateInboxItem) {
    if (item.status !== "message" && !window.confirm(`Remove ${item.fileName ?? "this certificate"}? It is deleted and not saved to any check.`)) return;
    setBusyId(item.id);
    try {
      await dismissCertificateInboxItem(item.id);
      await refresh();
    } catch (err) {
      toast({ title: "Could not remove it", description: err instanceof Error ? err.message : "Please try again", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="mb-6 p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Inbox className="w-5 h-5 text-primary" aria-hidden="true" />
          <h2 className="font-display text-lg font-semibold">Certificates to confirm</h2>
          {items.length > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">{items.length}</span>
          )}
        </div>
        {address && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Mail className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">Certificates can be emailed to</span>
            <span className="font-medium break-all">{address}</span>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2" onClick={() => void copyAddress()}>
              {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
              <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void changeAddress()}>
              Change address
            </Button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing waiting. Contractors can email certificates to this address, or upload them from the link in their reminder
          emails. Forward any you receive yourself, too: each one is read and waits here for you to check.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((item) => (
            <li key={item.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                {item.status === "held" ? <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
                  : item.status === "message" ? <Mail className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
                  : item.source === "upload" ? <Upload className="w-5 h-5 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                  : <FileText className="w-5 h-5 text-primary shrink-0 mt-0.5" aria-hidden="true" />}
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">
                    {item.reading?.certificateType || item.fileName || item.subject || "Email"}
                    {item.itemTitle && <span className="font-normal text-muted-foreground"> · {item.itemTitle}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{from(item)}{item.senderEmail && item.status === "held" ? ` (${item.senderEmail})` : ""}</p>
                  <p className={item.status === "held" ? "text-xs text-amber-700" : "text-xs text-muted-foreground"}>
                    {item.status === "reading" && <Loader2 className="inline w-3 h-3 mr-1 animate-spin" aria-hidden="true" />}
                    {STATUS_LABEL[item.status]}{item.note ? `: ${item.note}` : ""}
                  </p>
                  {item.status === "message" && item.messageText && (
                    <button type="button" className="text-xs text-primary hover:underline" onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
                      {expanded === item.id ? "Hide message" : "Read message"}
                    </button>
                  )}
                  {expanded === item.id && item.messageText && (
                    <p className="mt-2 whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{item.messageText}</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                {item.status === "ready" && (
                  <Button type="button" size="sm" onClick={() => setOpen(item)} disabled={busyId !== null}>Check and save</Button>
                )}
                {item.status === "held" && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void accept(item)} disabled={busyId !== null}>
                    {busyId === item.id ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden="true" /> : null}
                    Accept and check
                  </Button>
                )}
                {item.status !== "reading" && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => void dismiss(item)} disabled={busyId !== null}
                    aria-label={item.status === "message" ? "Done" : "Remove"}>
                    {item.status === "message" ? "Done" : <X className="w-4 h-4" aria-hidden="true" />}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <CertificateReaderDialog
          open={!!open}
          onOpenChange={(value) => { if (!value) setOpen(null); }}
          inbox={open}
          onFiled={() => void refresh()}
        />
      )}
    </Card>
  );
}
