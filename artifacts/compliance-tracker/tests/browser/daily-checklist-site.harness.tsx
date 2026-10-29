// Browser harness for tests/daily-checklist-site-browser.test.mjs: mounts a
// real page with a site picker and a form (?page=daily-am, the default;
// room-track; kitchen-cleaning) with the app's Tailwind styles. The page
// layout and signed-in user are stubbed; the test intercepts the API.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../src/index.css";
import DailyTrackAmPage from "../../src/pages/daily-track-am";
import RoomTrackPage from "../../src/pages/room-track";
import CleaningScheduleTab from "../../src/pages/kitchen-cleaning";
import { Toaster } from "../../src/components/ui/toaster";

const pages = { "daily-am": DailyTrackAmPage, "room-track": RoomTrackPage, "kitchen-cleaning": CleaningScheduleTab };
const Page = pages[(new URLSearchParams(window.location.search).get("page") ?? "daily-am") as keyof typeof pages] ?? DailyTrackAmPage;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Page />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
