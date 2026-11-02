// Browser harness for tests/record-media-browser.test.mjs: a "Record check"
// form with the real photo and video box (useRecordMedia), saved the way the
// track forms save, followed by the saved record's real CheckPhotoUploader.
// The test intercepts the API and storage requests.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { useRecordMedia } from "../../src/components/record-media";
import { CheckPhotoUploader } from "../../src/components/check-photo-uploader";
import { Button } from "../../src/components/ui/button";
import { Toaster } from "../../src/components/ui/toaster";
import { apiFetch } from "../../src/lib/api";

function RecordCheckForm() {
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);
  const media = useRecordMedia("fire_safety_check", { disabled: saving });

  async function save() {
    setSaving(true);
    try {
      const response = await apiFetch("/fire-safety", { method: "POST", body: JSON.stringify({ checkType: "fire_door" }) });
      const created = await response.json() as { id: number };
      await media.attach(created.id);
      setSavedId(created.id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="max-w-xl space-y-4 p-6">
      <section className="space-y-3 rounded border p-4" data-testid="record-form">
        <h1 className="font-medium">Record Fire Safety Check</h1>
        {media.picker}
        <Button type="button" onClick={() => void save()} disabled={saving || media.attaching}>
          {media.attaching ? "Adding photos…" : saving ? "Saving…" : "Record Check"}
        </Button>
      </section>
      {savedId && (
        <section className="rounded border p-4" data-testid="saved-record">
          <CheckPhotoUploader entityType="fire_safety_check" entityId={savedId} />
        </section>
      )}
      <Toaster />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<RecordCheckForm />);
