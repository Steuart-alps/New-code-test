// Browser harness for tests/daily-checklist-card-browser.test.mjs: mounts the
// real DailyTrack AM checklist card with the app's Tailwind styles. The test
// intercepts the API; nothing here talks to a server.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ChecklistCard } from "../../src/pages/daily-track-am";
import { Toaster } from "../../src/components/ui/toaster";

declare global {
  interface Window { savedCount: number }
}
window.savedCount = 0;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="p-6 max-w-xl">
      <button type="button" id="before">Before card</button>
      <div className="my-4">
        <ChecklistCard
          type="kitchen_opening"
          siteId={5}
          date="2026-10-12"
          canAdmin={false}
          onSaved={() => { window.savedCount += 1; }}
        />
      </div>
    </main>
    <Toaster />
  </StrictMode>,
);
