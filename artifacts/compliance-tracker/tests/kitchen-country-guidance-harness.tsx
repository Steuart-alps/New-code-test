import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../src/context/auth-context";
import { KitchenTemperatureControls } from "../src/components/kitchen-temperature-controls";
import "../src/index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <div className="p-4"><KitchenTemperatureControls /></div>
    </AuthProvider>
  </QueryClientProvider>,
);
