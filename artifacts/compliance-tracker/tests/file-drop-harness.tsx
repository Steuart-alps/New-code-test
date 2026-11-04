import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PendingMediaPicker } from "../src/components/pending-media-picker";
import { Input } from "../src/components/ui/input";
import { Toaster } from "../src/components/ui/toaster";
import { isSpreadsheetFile } from "../src/components/spreadsheet-drop-zone";
import { installStrayFileDropGuard, useFileDrop } from "../src/hooks/use-file-drop";
import { toast } from "../src/hooks/use-toast";
import "../src/index.css";

declare global {
  interface Window { __files: Record<string, Array<{ name: string; type: string }>>; __raw: Record<string, File[]> }
}
window.__files = {};
window.__raw = {};
installStrayFileDropGuard();

// Like the new FixTrack issue form: text boxes, with one photos box below.
// Also used by camera-capture-browser.test.mjs.
function IssueForm({ name }: { name: string }) {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <section className="space-y-3 rounded border p-4" data-testid={`form-${name}`}>
      <label className="block text-sm">Title <Input aria-label={`${name} title`} /></label>
      <p className="text-sm" data-testid={`beside-${name}`}>Describe the issue, then add photos.</p>
      <PendingMediaPicker testId={`media-${name}`} files={files}
        onChange={(next) => {
          setFiles(next);
          window.__files[name] = next.map((file) => ({ name: file.name, type: file.type }));
          window.__raw[name] = next;
        }} />
    </section>
  );
}

// Like an Import spreadsheet button: takes spreadsheets only.
function SheetButton() {
  const drop = useFileDrop((files) => {
    window.__files.sheet = [...(window.__files.sheet ?? []), ...files.map((file) => ({ name: file.name, type: file.type }))];
  }, true, isSpreadsheetFile);
  return <button type="button" data-testid="sheet-button" {...drop.dropZoneProps}>Import spreadsheet</button>;
}

function Harness() {
  const query = new URLSearchParams(location.search);
  return (
    <main className="space-y-4 p-6">
      <h1 data-testid="page-heading">FixTrack</h1>
      {!query.has("sheet-only") && <IssueForm name="first" />}
      {query.has("two") && <IssueForm name="second" />}
      {(query.has("sheet") || query.has("sheet-only")) && <SheetButton />}
      <button type="button" onClick={() => toast({ title: "Saved" })}>Show saved message</button>
      <Toaster />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
