// Browser harness for tests/daily-track-month-browser.test.mjs: mounts the
// real DailyTrack status month calendar with the app's Tailwind styles. The
// test intercepts the API; nothing here talks to a server.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { MonthOverview } from "../../src/pages/daily-track-status";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="p-6 max-w-2xl">
      <MonthOverview sites={[{ id: 1, name: "Main kitchen" }, { id: 2, name: "Riverside" }]} onPickDay={() => {}} />
    </main>
  </StrictMode>,
);
