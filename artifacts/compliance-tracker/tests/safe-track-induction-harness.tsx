import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { AuthProvider } from "../src/context/auth-context";
import SafeTrackPage from "../src/pages/safe-track";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

// The SafeTrack page itself. The app's /safe-track route redirects to
// DocTrack, so the page is mounted directly, against the real API.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AuthProvider>
        <Router>
          <SafeTrackPage />
        </Router>
        <Toaster />
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>,
);
