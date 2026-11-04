import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { AuthProvider } from "../src/context/auth-context";
import FireSafetyPage from "../src/pages/fire-safety";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});
const useHarnessLocation = () => ["/fire-safety", () => undefined] as const;

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <Router hook={useHarnessLocation}>
        <TooltipProvider>
          <FireSafetyPage />
          <Toaster />
        </TooltipProvider>
      </Router>
    </AuthProvider>
  </QueryClientProvider>,
);
