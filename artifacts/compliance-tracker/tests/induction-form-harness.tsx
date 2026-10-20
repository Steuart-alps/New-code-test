import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InductionForm } from "../src/pages/safe-track";
import "../src/index.css";

// The SafeTrack induction form with the page's own state shape; the form state
// is mirrored into the DOM so the test can read exactly what would be saved.
function Harness() {
  const [form, setForm] = useState<Record<string, unknown>>({ staffName: "", startDate: "", completedAt: null, notes: "", checklist: null });
  return (
    <div className="p-6 max-w-3xl space-y-4">
      <InductionForm form={form} setForm={setForm} />
      <pre data-testid="form-state">{JSON.stringify(form)}</pre>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
