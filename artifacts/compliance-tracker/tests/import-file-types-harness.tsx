import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../src/context/auth-context";
import { ImportCsvButton } from "../src/components/import-csv-dialog";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

function Harness() {
  const { user, isLoading } = useAuth();
  if (isLoading || !user) return <p>Loading test account</p>;
  return <>
    <input data-testid="harness-text-box" aria-label="Some other text box" />
    <ImportCsvButton type="contractors" />
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
