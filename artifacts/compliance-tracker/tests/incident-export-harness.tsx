import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { AuthProvider } from "../src/context/auth-context";
import IncidentsPage from "../src/pages/incidents";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});
const useHarnessLocation = () => ["/incidents", () => undefined] as const;

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <Router hook={useHarnessLocation}>
        <TooltipProvider>
          <IncidentsPage />
          <Toaster />
        </TooltipProvider>
      </Router>
    </AuthProvider>
  </QueryClientProvider>,
);
