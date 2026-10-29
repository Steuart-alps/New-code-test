// Browser harness for tests/daily-checklist-site-browser.test.mjs: mounts the
// real DailyTrack AM page (site picker and checklist cards) with the app's
// Tailwind styles. The page layout and signed-in user are stubbed; the test
// intercepts the API.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../src/index.css";
import DailyTrackAmPage from "../../src/pages/daily-track-am";
import { Toaster } from "../../src/components/ui/toaster";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DailyTrackAmPage />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
