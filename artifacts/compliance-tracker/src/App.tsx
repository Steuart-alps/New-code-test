import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/context/auth-context";

import Dashboard from "@/pages/dashboard";
import ContractorsPage from "@/pages/contractors";
import ContractorDetailPage from "@/pages/contractor-detail";
import ExternalChecksPage from "@/pages/external-checks";
import CategoriesPage from "@/pages/categories";
import SettingsPage from "@/pages/settings";
import UsersPage from "@/pages/users";
import ClientsPage from "@/pages/clients";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5,
    },
  },
});

function Redirect({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(to); }, [to]);
  return null;
}

function ProtectedRoutes() {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!user) {
    if (location !== "/login") {
      return <Redirect to="/login" />;
    }
    return <LoginPage />;
  }

  if (location === "/login") {
    return <Redirect to="/" />;
  }

  const canAdmin = user.role === "consultant" || user.role === "client_admin";
  const isConsultant = user.role === "consultant";

  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/contractors" component={ContractorsPage} />
      <Route path="/contractors/:id" component={ContractorDetailPage} />
      <Route path="/external" component={ExternalChecksPage} />
      {canAdmin && <Route path="/categories" component={CategoriesPage} />}
      {canAdmin && <Route path="/users" component={UsersPage} />}
      {canAdmin && <Route path="/settings" component={SettingsPage} />}
      {isConsultant && <Route path="/clients" component={ClientsPage} />}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <ProtectedRoutes />
          </WouterRouter>
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
