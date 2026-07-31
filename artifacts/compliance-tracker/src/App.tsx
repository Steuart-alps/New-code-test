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
import CategoryDetailPage from "@/pages/category-detail";
import SitesPage from "@/pages/sites";
import SiteDetailPage from "@/pages/site-detail";
import SettingsPage from "@/pages/settings";
import UsersPage from "@/pages/users";
import ClientsPage from "@/pages/clients";
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import LandingPage from "@/pages/landing";
import ResetPasswordPage from "@/pages/reset-password";
import TrialEndedPage from "@/pages/trial-ended";
import TermsPage from "@/pages/terms";
import PrivacyPage from "@/pages/privacy";
import SchedulePage from "@/pages/schedule";
import ItemDetailPage from "@/pages/item-detail";
import FireSafetyPage from "@/pages/fire-safety";
import KitchenPage from "@/pages/kitchen";
import LegionellaPage from "@/pages/legionella";
import SafeTrackPage from "@/pages/safe-track";
import FixTrackPage from "@/pages/fix-track";
import DocTrackPage from "@/pages/doc-track";
import TrainTrackPage from "@/pages/train-track";
import DailyTrackAmPage from "@/pages/daily-track-am";
import DailyTrackPmPage from "@/pages/daily-track-pm";
import DailyTrackStatusPage from "@/pages/daily-track-status";
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
  const { user, billingLocked, isLoading } = useAuth();
  const [location] = useLocation();

  // Always-public routes
  if (location === "/reset-password") return <ResetPasswordPage />;
  if (location === "/signup") return <SignupPage />;
  if (location === "/terms") return <TermsPage />;
  if (location === "/privacy") return <PrivacyPage />;
  if (location.startsWith("/schedule/")) return <SchedulePage />;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm animate-pulse">Loading...</div>
      </div>
    );
  }

  // Not logged in
  if (!user) {
    if (location === "/login") return <LoginPage />;
    // Show landing page at root when not logged in
    if (location === "/" || location === "") return <LandingPage />;
    return <Redirect to="/" />;
  }

  // Trial expired without a subscription: the whole app is replaced by the
  // billing-required screen (which lets consultants pay and everyone log out).
  if (billingLocked) {
    return <TrialEndedPage />;
  }

  // Logged in — redirect away from public pages
  if (location === "/login" || location === "/") {
    return <Redirect to="/dashboard" />;
  }

  const canAdmin = user.role === "consultant" || user.role === "client_admin";
  const isConsultant = user.role === "consultant";

  return (
    <Switch>
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/contractors" component={ContractorsPage} />
      <Route path="/contractors/:id" component={ContractorDetailPage} />
      <Route path="/external" component={ExternalChecksPage} />
      <Route path="/external-checks" component={ExternalChecksPage} />
      <Route path="/items/:id" component={ItemDetailPage} />
      <Route path="/fire-safety" component={FireSafetyPage} />
      <Route path="/kitchen" component={KitchenPage} />
      <Route path="/legionella" component={LegionellaPage} />
      <Route path="/safe-track" component={SafeTrackPage} />
      <Route path="/fix-track" component={FixTrackPage} />
      <Route path="/doc-track" component={DocTrackPage} />
      <Route path="/train-track" component={TrainTrackPage} />
      <Route path="/daily-track-am" component={DailyTrackAmPage} />
      <Route path="/daily-track-pm" component={DailyTrackPmPage} />
      <Route path="/daily-track-status" component={DailyTrackStatusPage} />
      {canAdmin && <Route path="/sites/:id" component={SiteDetailPage} />}
      {canAdmin && <Route path="/sites" component={SitesPage} />}
      {canAdmin && <Route path="/categories/:id" component={CategoryDetailPage} />}
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
