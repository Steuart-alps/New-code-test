import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { AuthProvider } from "../src/context/auth-context";
// Keep the production Coming soon rollout gate; test the actual record page.
import { GreenTrackPageInternal as GreenTrackPage } from "../src/pages/green-track";
import SwimTrackPage from "../src/pages/swim-track";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
  },
});

const page = new URLSearchParams(window.location.search).get("page");
const route = page === "swim" ? "/swim-track" : "/green-track";
const useHarnessLocation = () => [route, () => undefined] as const;
const selectedPage = page === "swim" ? <SwimTrackPage /> : <GreenTrackPage />;

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