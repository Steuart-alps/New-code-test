import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../src/context/auth-context";
import SafeTrackPage from "../src/pages/safe-track";
import KitchenPage from "../src/pages/kitchen";
import BikeTrackPage from "../src/pages/bike-track";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
  },
});

const page = new URLSearchParams(window.location.search).get("page");
const pages = {
  safe: <SafeTrackPage />,
  kitchen: <KitchenPage />,
  bike: <BikeTrackPage />,
} as const;

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        {pages[page as keyof typeof pages] ?? <p>Unknown photo upload harness page.</p>}
        <Toaster />
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>,
);