import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../src/context/auth-context";
import { SayItButton } from "../src/components/say-it-button";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <main className="p-4">
          <h1 className="mb-3 text-xl font-bold">Dashboard</h1>
          <SayItButton className="w-full h-11" />
        </main>
        <Toaster />
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>,
);
