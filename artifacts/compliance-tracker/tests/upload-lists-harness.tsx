import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../src/context/auth-context";
import { UploadLists } from "../src/pages/upload-lists";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

function Harness() {
  const { user, isLoading } = useAuth();
  if (isLoading || !user) return <p>Loading test account</p>;
  return <>
    <UploadLists />
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
