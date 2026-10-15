import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../src/context/auth-context";
import { FormOptionsEditor } from "../src/components/form-options-editor";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

// Same labelling as the FixTrack trades editor (src/pages/fix-track.tsx).
const humanizeType = (value: string) =>
  value.split("_").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <FormOptionsEditor
          optionKey="fixtrack_trades"
          title="Contractor trades"
          triggerLabel="Customise trades"
          labelFor={humanizeType}
        />
        <Toaster />
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>,
);
