// Browser harness for tests/dashboard-site-switch-browser.test.mjs: mounts the
// real dashboard page with the app's React Query client and Tailwind styles.
// The app shell and auth context are stubbed; the test intercepts the API.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../src/index.css";
import Dashboard from "../../src/pages/dashboard";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  </StrictMode>,
);
