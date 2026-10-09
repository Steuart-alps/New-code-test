import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../src/context/auth-context";
import { LegacyPATRegister } from "../src/components/pat-track/legacy-register";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

function Harness() {
  const { user, isLoading } = useAuth();
  const [view, setView] = useState<"appliances" | "tests">("appliances");
  if (isLoading || !user) return <p>Loading test account</p>;
  return <>
    <button type="button" data-testid="harness-view-appliances" onClick={() => setView("appliances")}>Appliances view</button>
    <button type="button" data-testid="harness-view-tests" onClick={() => setView("tests")}>Tests view</button>
    <LegacyPATRegister view={view} />
    <Toaster />
  </>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <Harness />
    </AuthProvider>
  </QueryClientProvider>,
);
