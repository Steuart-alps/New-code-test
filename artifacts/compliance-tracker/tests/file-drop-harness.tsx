import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PendingMediaPicker } from "../src/components/pending-media-picker";
import { Input } from "../src/components/ui/input";
import { Toaster } from "../src/components/ui/toaster";
import { installStrayFileDropGuard } from "../src/hooks/use-file-drop";
import "../src/index.css";

declare global {
  interface Window { __files: Record<string, Array<{ name: string; type: string }>> }
}
window.__files = {};
installStrayFileDropGuard();

// Like the new FixTrack issue form: text boxes, with one photos box below.
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
        }} />
    </section>
  );
}

function Harness() {
  const second = new URLSearchParams(location.search).has("two");
  return (
    <main className="space-y-4 p-6">
      <h1 data-testid="page-heading">FixTrack</h1>
      <IssueForm name="first" />
      {second && <IssueForm name="second" />}
      <Toaster />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
