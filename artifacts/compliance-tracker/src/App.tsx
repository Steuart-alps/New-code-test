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
import FixTrackPage from "@/pages/fix-track";
import DocTrackPage from "@/pages/doc-track";
import TrainTrackPage from "@/pages/train-track";
import HotTubPage from "@/pages/hot-tub";
import TreeTrackPage from "@/pages/tree-track";
import BikeTrackPage from "@/pages/bike-track";
import PoolTrackPage from "@/pages/pool-track";
import GreenTrackPage from "@/pages/green-track";
import SwimTrackPage from "@/pages/swim-track";
import DailyTrackAmPage from "@/pages/daily-track-am";
import DailyTrackPmPage from "@/pages/daily-track-pm";
import DailyTrackStatusPage from "@/pages/daily-track-status";
import StaffRosterPage from "@/pages/staff-roster";
import SignOffPage from "@/pages/sign-off";
import IncidentsPage from "@/pages/incidents";
import PATTrackPage  from "@/pages/pat-track";
import PestTrackPage from "@/pages/pest-track";
import PremisesTrackPage from "@/pages/premises-track";
import ReportsPage from "@/pages/reports";
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
  if (location.startsWith("/sign-off/")) return <SignOffPage />;

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
      <Route path="/safe-track" component={() => { window.location.replace("/doc-track"); return null; }} />
      <Route path="/fix-track" component={FixTrackPage} />
      <Route path="/doc-track" component={DocTrackPage} />
      <Route path="/train-track" component={TrainTrackPage} />
      <Route path="/hot-tub" component={HotTubPage} />
      <Route path="/tree-track" component={TreeTrackPage} />
      <Route path="/bike-track" component={BikeTrackPage} />
      <Route path="/pool-track"  component={PoolTrackPage} />
      <Route path="/green-track" component={GreenTrackPage} />
      <Route path="/swim-track"  component={SwimTrackPage} />
      <Route path="/daily-track-am" component={DailyTrackAmPage} />
      <Route path="/daily-track-pm" component={DailyTrackPmPage} />
      <Route path="/daily-track-status" component={DailyTrackStatusPage} />
      <Route path="/incidents" component={IncidentsPage} />
      <Route path="/pat-track"  component={PATTrackPage} />
      <Route path="/pest-track" component={PestTrackPage} />
      <Route path="/premises-track" component={PremisesTrackPage} />
      <Route path="/reports" component={ReportsPage} />
      {canAdmin && <Route path="/sites/:id" component={SiteDetailPage} />}
      {canAdmin && <Route path="/sites" component={SitesPage} />}
      {canAdmin && <Route path="/categories/:id" component={CategoryDetailPage} />}
      {canAdmin && <Route path="/categories" component={CategoriesPage} />}
      {canAdmin && <Route path="/users" component={UsersPage} />}
      {canAdmin && <Route path="/staff-roster" component={StaffRosterPage} />}
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
