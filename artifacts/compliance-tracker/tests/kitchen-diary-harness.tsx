import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../src/context/auth-context";
import { DailyDiaryTab } from "../src/pages/kitchen";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});
// The browser test triggers refetches the way a window refocus or another
// tab's invalidation would.
(window as unknown as { __queryClient: QueryClient }).__queryClient = queryClient;

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <DailyDiaryTab />
        <Toaster />
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>,
);
