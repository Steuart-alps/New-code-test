import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { AuthProvider } from "../src/context/auth-context";
// Keep the production Coming soon rollout gate; test the actual record page.
import { GreenTrackPageInternal as GreenTrackPage } from "../src/pages/green-track";
import SwimTrackPage from "../src/pages/swim-track";
// /swim-track redirects here in the app; this is the page users actually see.
import AquaTrackPage from "../src/pages/aqua-track";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
  },
});

const page = new URLSearchParams(window.location.search).get("page");
const route = page === "swim" ? "/swim-track" : page === "aqua" ? "/aqua-track" : "/green-track";
const useHarnessLocation = () => [route, () => undefined] as const;
const selectedPage = page === "swim" ? <SwimTrackPage /> : page === "aqua" ? <AquaTrackPage /> : <GreenTrackPage />;

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <Router hook={useHarnessLocation}>
        <TooltipProvider>
          {selectedPage}
          <Toaster />
        </TooltipProvider>
      </Router>
    </AuthProvider>
  </QueryClientProvider>,
);