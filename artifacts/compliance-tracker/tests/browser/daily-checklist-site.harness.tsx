// Browser harness for tests/daily-checklist-site-browser.test.mjs: mounts a
// real page with a site picker and a form (?page=daily-am, the default;
// room-track; kitchen-cleaning) and the top bar's working-site picker, with
// the app's Tailwind styles. The page
// layout and signed-in user are stubbed; the test intercepts the API.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../src/index.css";
import DailyTrackAmPage from "../../src/pages/daily-track-am";
import RoomTrackPage from "../../src/pages/room-track";
import CleaningScheduleTab from "../../src/pages/kitchen-cleaning";
import { Toaster } from "../../src/components/ui/toaster";
import { WorkingSiteSwitcher } from "../../src/components/working-site-switcher";

const pages = { "daily-am": DailyTrackAmPage, "room-track": RoomTrackPage, "kitchen-cleaning": CleaningScheduleTab };
const Page = pages[(new URLSearchParams(window.location.search).get("page") ?? "daily-am") as keyof typeof pages] ?? DailyTrackAmPage;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* The app shows this in the top bar of every page. */}
      <header className="p-4 border-b"><WorkingSiteSwitcher /></header>
      <Page />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
