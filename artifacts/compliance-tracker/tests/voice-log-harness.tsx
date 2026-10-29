import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../src/context/auth-context";
import { SayItButton } from "../src/components/say-it-button";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import { useState } from "react";
import { useSayItFill, type SayItFill } from "../src/lib/say-it-fill";
import type { SayItFormKey } from "../src/lib/voice-forms";

const FORM_KEYS: SayItFormKey[] = ["pool-test", "swim-surveillance", "tub-test", "pat-test", "pest-activity", "room-check",
  "tree-inspection", "bike", "machine", "training", "incident", "premises-inspection"];
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

// Stands in for the track pages: shows the form Say it asked a page to open.
function FilledForm() {
  const [fill, setFill] = useState<SayItFill | null>(null);
  useSayItFill(FORM_KEYS, setFill);
  return fill ? <pre data-testid="say-it-fill">{JSON.stringify(fill)}</pre> : null;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <main className="p-4">
          <h1 className="mb-3 text-xl font-bold">Dashboard</h1>
          <SayItButton className="w-full h-11" />
          <FilledForm />
        </main>
        <Toaster />
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>,
);
