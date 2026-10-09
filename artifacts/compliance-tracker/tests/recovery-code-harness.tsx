import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../src/context/auth-context";
import { TwoFactorCard } from "../src/pages/settings";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
  },
});

function RecoveryCodeHarness() {
  const { user, refresh } = useAuth();

  return (
    <>
      <button type="button" data-testid="button-refresh-test-auth" onClick={() => void refresh()}>
        Refresh test account
      </button>
      <TwoFactorCard key={user?.id ?? "signed-out"} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <RecoveryCodeHarness />
    </AuthProvider>
  </QueryClientProvider>,
);