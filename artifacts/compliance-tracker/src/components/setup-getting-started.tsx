import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Building2, CheckCircle2, ClipboardList, Download, FileCheck2, FileSpreadsheet, HardHat, Handshake, MapPin, Network, Sparkles, UsersRound, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDay } from "@/lib/onboarding";
import { INFO_SHEETS, SETUP_SERVICE_FEE, downloadInfoSheet, type InfoSheet } from "@/lib/setup-info-sheets";

export type SetupAi = { configured: boolean; active: boolean };
export type SetupAssistRequest = { requestedAt: string; requestedBy: string };

/** Shown on the setup service offer. ALPS invoices it; nothing is charged in the app. */
export const SETUP_SERVICE_PRICE_NOTE = `A one-off fee of ${SETUP_SERVICE_FEE}, invoiced separately from your subscription.`;

/** The workbooks every business needs; the per-track ones sit under them. */
const MAIN_SHEETS = new Set(["getting-started", "contractors", "compliance"]);

const HAVE_READY = [
  { icon: MapPin, title: "Your sites", text: "The name and address of each premises." },
  { icon: Network, title: "Departments", text: "The teams at each site, for example Kitchen, Housekeeping or Greenkeeping." },
  { icon: UsersRound, title: "Your team", text: "Names and email addresses of the Managers and Staff who will record checks, plus a list of other staff for training records." },
  { icon: Wrench, title: "Equipment lists", text: "Portable appliances, machinery and mowers, rooms, fire alarm call points." },
  { icon: HardHat, title: "Contractors", text: "Company, contact, email, phone and what they do (Gas Safe number for gas engineers)." },
  { icon: FileCheck2, title: "Certificates and service dates", text: "When things were last done: fire alarm, emergency lighting, electrical (EICR), gas safety, legionella, lifting equipment, insurance." },
  { icon: ClipboardList, title: "Documents you already have", text: "Risk assessments, policies, HACCP plan. These can be added at any time." },
];

/** The page before step 1 of setup: what to have ready, what AI can read, and the setup service. */
export function SetupGettingStarted({ ai, assistRequest, canRequestAssist, onRequestAssist, onStart, started }: {
  ai?: SetupAi;
  assistRequest: SetupAssistRequest | null;
  /** ALPS consultants already are the setup service, so they aren't offered it. */
  canRequestAssist: boolean;
  onRequestAssist: (details: { phone: string; notes: string }) => Promise<void>;
  onStart: () => void;
  /** Setup is already under way, so the button says "Carry on". */
  started: boolean;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm space-y-5" aria-labelledby="getting-started-heading">
      <div>
        <h2 id="getting-started-heading" className="text-lg font-bold">Before you get started</h2>
        <p className="text-sm text-muted-foreground">Setting up one site takes about 20 to 30 minutes. It's quicker with these to hand, but anything you don't have yet can be added later.</p>
      </div>

      <ul className="space-y-3">
        {HAVE_READY.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3">
            <Icon className="w-5 h-5 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">{title}</p>
              <p className="text-xs text-muted-foreground">{text}</p>
            </div>
          </li>
        ))}
      </ul>

      <InfoSheetDownloads />

      <AiNote ai={ai} />

      {canRequestAssist && <SetupServiceOffer request={assistRequest} onRequest={onRequestAssist} />}

      <div className="flex justify-end pt-1">
        <Button onClick={onStart}>
          {started ? "Carry on with setup" : "Start setting up"} <ArrowRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </section>
  );
}

function InfoSheetDownloads() {
  const main = INFO_SHEETS.filter((sheet) => MAIN_SHEETS.has(sheet.key));
  const tracks = INFO_SHEETS.filter((sheet) => !MAIN_SHEETS.has(sheet.key));
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex gap-3">
        <FileSpreadsheet className="w-5 h-5 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-semibold">What we need from you: Excel checklists</p>
          <p className="text-sm text-muted-foreground">One workbook for each track, with a tab for every list to gather. Lists such as staff, contractors and equipment can be uploaded straight back in: choose the whole workbook in "Import spreadsheet". Or send them to ALPS with a setup request.</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {main.map((sheet) => <SheetButton key={sheet.key} sheet={sheet} />)}
      </div>
      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-primary hover:underline">Checklists for each track ({tracks.length})</summary>
        <div className="grid gap-2 sm:grid-cols-2 pt-3">
          {tracks.map((sheet) => <SheetButton key={sheet.key} sheet={sheet} />)}
        </div>
      </details>
    </div>
  );
}

function SheetButton({ sheet }: { sheet: InfoSheet }) {
  return (
    <Button type="button" variant="outline" size="sm" className="justify-start h-auto py-2 text-left whitespace-normal"
      onClick={() => void downloadInfoSheet(sheet)} data-testid={`button-download-info-${sheet.key}`}>
      <Download className="w-4 h-4 mr-2 shrink-0" aria-hidden="true" /> {sheet.label}
    </Button>
  );
}

function AiNote({ ai }: { ai?: SetupAi }) {
  const lists = "staff lists, contractor lists, equipment and room lists (Excel, Word, PDF or a photo) and certificates (it reads the dates and who did the work)";
  if (ai?.active) {
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-1">
        <p className="text-sm font-semibold flex items-center gap-2"><Sparkles className="w-4 h-4 text-primary" aria-hidden="true" /> AI features are on</p>
        <p className="text-sm text-muted-foreground">You can upload rather than type. ComplyTrack can read {lists}. Always check what it read before you save.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-1">
      <p className="text-sm font-semibold flex items-center gap-2"><Sparkles className="w-4 h-4 text-muted-foreground" aria-hidden="true" /> Upload rather than type</p>
      <p className="text-sm text-muted-foreground">
        Lists in Excel, CSV or a Word table can be imported straight in.
        {ai?.configured && <> With the AI features add-on, ComplyTrack can also read {lists}. <Link href="/settings#ai" className="text-primary hover:underline">Turn on AI features</Link></>}
      </p>
    </div>
  );
}

function SetupServiceOffer({ request, onRequest }: {
  request: SetupAssistRequest | null;
  onRequest: (details: { phone: string; notes: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    setSending(true);
    try {
      await onRequest({ phone: phone.trim(), notes: notes.trim() });
      setOpen(false);
    } catch {
      // The page has already said why; the form stays open to try again.
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex gap-3">
        <Handshake className="w-5 h-5 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-semibold">Rather we did it for you?</p>
          <p className="text-sm text-muted-foreground">ALPS can enter your initial data for you: sites, departments, team, equipment, contractors and certificate dates. Send us what you have and we'll set it up, then go through it with you.</p>
          <p className="text-xs text-muted-foreground">{SETUP_SERVICE_PRICE_NOTE}</p>
        </div>
      </div>

      {request ? (
        <p className="text-sm flex items-start gap-2 rounded-md bg-emerald-50 text-emerald-800 p-3 dark:bg-emerald-950/40 dark:text-emerald-200" role="status">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>Request sent on {formatDay(request.requestedAt.slice(0, 10))}{request.requestedBy ? ` by ${request.requestedBy}` : ""}. ALPS will be in touch to arrange how to send your lists. You can carry on setting up in the meantime.</span>
        </p>
      ) : open ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="setup-assist-phone">Best phone number (optional)</Label>
            <Input id="setup-assist-phone" type="tel" autoComplete="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="setup-assist-notes">Anything we should know (optional)</Label>
            <Textarea id="setup-assist-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="For example: 4 sites, staff list in Excel, certificates in a folder in the office" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={sending}>Cancel</Button>
            <Button onClick={send} disabled={sending}>{sending ? "Sending…" : "Send request to ALPS"}</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Building2 className="w-4 h-4 mr-1" /> Ask ALPS to set it up for you
        </Button>
      )}
    </div>
  );
}
