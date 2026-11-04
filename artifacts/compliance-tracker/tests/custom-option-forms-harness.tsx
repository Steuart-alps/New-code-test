import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router, Switch } from "wouter";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "../src/context/auth-context";
import ContractorsPage from "../src/pages/contractors";
import ContractorDetailPage from "../src/pages/contractor-detail";
import PremisesTrackPage from "../src/pages/premises-track";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

// ?route=/contractors, /contractors/:id or /premises-track: the same routes and
// pages App.tsx mounts.
const route = new URLSearchParams(window.location.search).get("route") ?? "/contractors";
const useHarnessLocation = () => [route, () => undefined] as const;

// App.tsx shows nothing but a loader until the session (and a consultant's
// selected business) has been restored; pages never mount before that.
function SessionGate({ children }: { children: ReactNode }) {
  const { isLoading, user } = useAuth();
  return isLoading || !user ? null : <>{children}</>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <Router hook={useHarnessLocation}>
        <TooltipProvider>
          <SessionGate>
            <Switch>
              <Route path="/contractors" component={ContractorsPage} />
              <Route path="/contractors/:id" component={ContractorDetailPage} />
              <Route path="/premises-track" component={PremisesTrackPage} />
            </Switch>
          </SessionGate>
          <Toaster />
        </TooltipProvider>
      </Router>
    </AuthProvider>
  </QueryClientProvider>,
);
