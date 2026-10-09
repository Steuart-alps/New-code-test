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
import AccountSecurityPage from "@/pages/account-security";
import UsersPage from "@/pages/users";
import ClientsPage, { LockedClientsPage } from "@/pages/clients";
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import LandingPage from "@/pages/landing";
import ResetPasswordPage from "@/pages/reset-password";
import TwoFaRecoverPage from "@/pages/two-fa-recover";
import MandatoryTwoFactorPage from "@/pages/mandatory-two-factor";
import TrialEndedPage from "@/pages/trial-ended";
import TermsPage from "@/pages/terms";
import PrivacyPage from "@/pages/privacy";
import PrivacyGovernancePage from "@/pages/privacy-governance";
import VerifyEmailPage from "@/pages/verify-email";
import SchedulePage from "@/pages/schedule";
import ItemDetailPage from "@/pages/item-detail";
import FireSafetyPage from "@/pages/fire-safety";
import KitchenPage from "@/pages/kitchen";
import LegionellaPage from "@/pages/legionella";
import FixTrackPage from "@/pages/fix-track";
import FixTrackDetailPage from "@/pages/fix-track-detail";
import DocTrackPage from "@/pages/doc-track";
import TrainTrackPage from "@/pages/train-track";
import HotTubPage from "@/pages/hot-tub";
import TreeTrackPage from "@/pages/tree-track";
import BikeTrackPage from "@/pages/bike-track";
import AquaTrackPage from "@/pages/aqua-track";
import PoolTrackPage from "@/pages/pool-track";
import GreenTrackPage from "@/pages/green-track";
import SwimTrackPage from "@/pages/swim-track";
import DailyTrackAmPage from "@/pages/daily-track-am";
import DailyTrackPmPage from "@/pages/daily-track-pm";
import DailyTrackStatusPage from "@/pages/daily-track-status";
import StaffRosterPage from "@/pages/staff-roster";
import SignOffPage from "@/pages/sign-off";
import ContractorPortalPage from "@/pages/contractor-portal";
import ContractorApprovalsPage from "@/pages/contractor-approvals";
import ContractorQuotePage from "@/pages/contractor-quote";
import IncidentsPage from "@/pages/incidents";
import PATTrackPage  from "@/pages/pat-track";
import PestTrackPage from "@/pages/pest-track";
import PremisesTrackPage from "@/pages/premises-track";
import RoomTrackPage from "@/pages/room-track";
import ReportsPage from "@/pages/reports";
import ComplianceHubPage from "@/pages/compliance-hub";
import FeedbackInboxPage from "@/pages/feedback-inbox";
import NotFound from "@/pages/not-found";
import DailyOverviewPage from "@/pages/daily-overview";
import DailyChecklistPage from "@/pages/daily-checklist";
import DocumentsPage from "@/pages/documents";
import FoodSafetyPage from "@/pages/food-safety";
import DailyHistoryPage from "@/pages/daily-history";
import StaffTrainingPage from "@/pages/staff-training";
import { WaterSafetyPage } from "@/pages/safety-summary";
import { trackModuleFirstUse } from "@/lib/analytics";
import KioskPage, { StaffSetPinPage } from "@/pages/staff-kiosk";

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
  const { user, billingLocked, isLoading, activeClientId, needsTwoFactorSetup } = useAuth();
  const [location] = useLocation();

  useEffect(() => {
    const module = [
      ["/fire-safety", "firetrack"],
      ["/kitchen", "kitchentrack"],
      ["/food-safety", "kitchentrack"],
      ["/legionella", "legionellatrack"],
      ["/fix-track", "fixtrack"],
      ["/doc-track", "doctrack"],
      ["/safe-track", "safetrack"],
      ["/train-track", "traintrack"],
      ["/hot-tub", "hottubtrack"],
      ["/tree-track", "treetrack"],
      ["/bike-track", "biketrack"],
      ["/aqua-track", "aquatrack"],
      ["/pool-track", "pooltrack"],
      ["/swim-track", "swimtrack"],
      ["/green-track", "greentrack"],
      ["/incidents", "incidenttrack"],
      ["/pat-track", "pattrack"],
      ["/pest-track", "pesttrack"],
      ["/premises-track", "premisestrack"],
      ["/room-track", "roomtrack"],
      ["/daily-track-am", "dailytrack_am"],
      ["/daily-track-pm", "dailytrack_pm"],
      ["/daily/am", "dailytrack_am"],
      ["/daily/pm", "dailytrack_pm"],
    ].find(([path]) => location === path)?.[1];
    if (module) trackModuleFirstUse(activeClientId, module);
  }, [activeClientId, location]);

  // Always-public routes
  if (location === "/reset-password") return <ResetPasswordPage />;
  if (location === "/2fa-recover") return <TwoFaRecoverPage />;
  if (location === "/signup") return <SignupPage />;
  if (location === "/terms") return <TermsPage />;
  if (location === "/privacy") return <PrivacyPage />;
  if (location.startsWith("/verify-email")) return <VerifyEmailPage />;
  if (location.startsWith("/schedule/")) return <SchedulePage />;
  if (location.startsWith("/sign-off/")) return <SignOffPage />;
  if (location.startsWith("/contractor-portal/")) return <Route path="/contractor-portal/:token" component={ContractorPortalPage} />;
  if (location.startsWith("/contractor-quote/")) return <ContractorQuotePage />;
  if (location === "/kiosk") return <KioskPage />;
  if (location === "/staff/set-pin") return <StaffSetPinPage />;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm animate-pulse">Loading...</div>
      </div>
    );
  }

  if (needsTwoFactorSetup) return <MandatoryTwoFactorPage />;

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
    if (location === "/account-security") {
      return <AccountSecurityPage />;
    }
    if (location === "/settings" && (user.role === "consultant" || user.role === "client_admin")) {
      return <SettingsPage />;
    }
    if (location === "/clients" && user.role === "consultant") {
      return <LockedClientsPage />;
    }
    return <TrialEndedPage />;
  }

  // Logged in — redirect away from public pages
  if (location === "/login" || location === "/") {
    return <Redirect to="/dashboard" />;
  }

  const canAdmin = user.role === "consultant" || user.role === "client_admin";
  const canManageContractorEmails = canAdmin || user.isMaintenanceManager === true;
  const isConsultant = user.role === "consultant";

  return (
    <Switch>
      <Route path="/dashboard" component={Dashboard} />
      {canManageContractorEmails && <Route path="/contractor-approvals" component={ContractorApprovalsPage} />}
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
      <Route path="/fix-track/:id" component={FixTrackDetailPage} />
      <Route path="/doc-track" component={DocTrackPage} />
      <Route path="/train-track" component={TrainTrackPage} />
      <Route path="/hot-tub" component={HotTubPage} />
      <Route path="/tree-track" component={TreeTrackPage} />
      <Route path="/bike-track" component={BikeTrackPage} />
      <Route path="/aqua-track"  component={AquaTrackPage} />
      {/* Legacy URLs redirect to the combined AquaTrack page */}
      <Route path="/pool-track"  component={() => { window.location.replace("/aqua-track"); return null; }} />
      <Route path="/swim-track"  component={() => { window.location.replace("/aqua-track"); return null; }} />
      <Route path="/green-track" component={GreenTrackPage} />
      <Route path="/daily-track-am" component={DailyTrackAmPage} />
      <Route path="/daily-track-pm" component={DailyTrackPmPage} />
      <Route path="/daily-track-status" component={DailyTrackStatusPage} />
      <Route path="/incidents" component={IncidentsPage} />
      <Route path="/pat-track"  component={PATTrackPage} />
      <Route path="/pest-track" component={PestTrackPage} />
      <Route path="/premises-track" component={PremisesTrackPage} />
      <Route path="/room-track" component={RoomTrackPage} />
      <Route path="/reports" component={ReportsPage} />
      <Route path="/compliance-hub" component={ComplianceHubPage} />
      {canAdmin && <Route path="/sites/:id" component={SiteDetailPage} />}
      {canAdmin && <Route path="/sites" component={SitesPage} />}
      {canAdmin && <Route path="/categories/:id" component={CategoryDetailPage} />}
      {canAdmin && <Route path="/categories" component={CategoriesPage} />}
      {canAdmin && <Route path="/users" component={UsersPage} />}
      {canAdmin && <Route path="/staff-roster" component={StaffRosterPage} />}
      {canAdmin && <Route path="/feedback" component={FeedbackInboxPage} />}
      {canAdmin && <Route path="/settings" component={SettingsPage} />}
      <Route path="/account-security" component={AccountSecurityPage} />
      {canAdmin && <Route path="/privacy-governance" component={PrivacyGovernancePage} />}
      {isConsultant && <Route path="/clients" component={ClientsPage} />}
      {canAdmin && <Route path="/daily/overview" component={DailyOverviewPage} />}
      <Route path="/daily/am">{() => <DailyChecklistPage type="am" />}</Route>
      <Route path="/daily/pm">{() => <DailyChecklistPage type="pm" />}</Route>
      <Route path="/documents" component={DocumentsPage} />
      <Route path="/food-safety" component={FoodSafetyPage} />
      <Route path="/daily/history" component={DailyHistoryPage} />
      <Route path="/staff-training" component={StaffTrainingPage} />
      <Route path="/water-safety" component={WaterSafetyPage} />
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
