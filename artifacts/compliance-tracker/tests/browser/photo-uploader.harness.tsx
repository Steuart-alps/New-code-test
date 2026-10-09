// Browser harness for tests/photo-upload-browser.test.mjs: mounts the real
// CheckPhotoUploader with the app's Tailwind styles. The test intercepts the
// API and storage requests; nothing here talks to a server.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { CheckPhotoUploader } from "../../src/components/check-photo-uploader";
import { Toaster } from "../../src/components/ui/toaster";

const params = new URLSearchParams(location.search);
const compact = params.get("compact") === "1";
const readOnly = params.get("readOnly") === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="p-6 max-w-xl">
      <button type="button" id="before">Before uploader</button>
      <div className="my-4">
        <CheckPhotoUploader entityType="fire_safety_check" entityId={41} compact={compact} readOnly={readOnly} />
      </div>
      <button type="button" id="after">After uploader</button>
    </main>
    <Toaster />
  </StrictMode>,
);
