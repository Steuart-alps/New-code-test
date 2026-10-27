import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { lazy, Suspense, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { OverrideReasonDialog } from "@/components/override-reason-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/context/auth-context";

import { trackModuleFirstUse } from "@/lib/analytics";
import { pendingScanPath, rememberScanPath } from "@/lib/scan-return";
import { readBillingReturn } from "@/lib/billing-return";

// Each page is its own chunk so the landing and sign-in pages stay small and a
// page's code is only downloaded when someone opens it.
const Dashboard = lazy(() => import("@/pages/dashboard"));
const MyTrainingPage = lazy(() => import("@/pages/my-training"));
const ContractorsPage = lazy(() => import("@/pages/contractors"));
const ContractorDetailPage = lazy(() => import("@/pages/contractor-detail"));
const ExternalChecksPage = lazy(() => import("@/pages/external-checks"));
const CategoriesPage = lazy(() => import("@/pages/categories"));
const CategoryDetailPage = lazy(() => import("@/pages/category-detail"));
const SitesPage = lazy(() => import("@/pages/sites"));
const SiteDetailPage = lazy(() => import("@/pages/site-detail"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const AccountSecurityPage = lazy(() => import("@/pages/account-security"));
const UsersPage = lazy(() => import("@/pages/users"));
const LoginPage = lazy(() => import("@/pages/login"));
const SignupPage = lazy(() => import("@/pages/signup"));
const LandingPage = lazy(() => import("@/pages/landing"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));
const TwoFaRecoverPage = lazy(() => import("@/pages/two-fa-recover"));
const MandatoryTwoFactorPage = lazy(() => import("@/pages/mandatory-two-factor"));
const TrialEndedPage = lazy(() => import("@/pages/trial-ended"));
const TermsPage = lazy(() => import("@/pages/terms"));
const PrivacyPage = lazy(() => import("@/pages/privacy"));
const PublicSitePage = lazy(() => import("@/pages/public-site"));
const PrivacyGovernancePage = lazy(() => import("@/pages/privacy-governance"));
const VerifyEmailPage = lazy(() => import("@/pages/verify-email"));
const SchedulePage = lazy(() => import("@/pages/schedule"));
const ItemDetailPage = lazy(() => import("@/pages/item-detail"));
const FireSafetyPage = lazy(() => import("@/pages/fire-safety"));
const KitchenPage = lazy(() => import("@/pages/kitchen"));
const AllergensPage = lazy(() => import("@/pages/allergens"));
const AsbestosRegisterPage = lazy(() => import("@/pages/asbestos-register"));
const LegionellaPage = lazy(() => import("@/pages/legionella"));
const FixTrackPage = lazy(() => import("@/pages/fix-track"));
const FixTrackDetailPage = lazy(() => import("@/pages/fix-track-detail"));
const DocTrackPage = lazy(() => import("@/pages/doc-track"));
const TrainTrackPage = lazy(() => import("@/pages/train-track"));
const HotTubPage = lazy(() => import("@/pages/hot-tub"));
const TreeTrackPage = lazy(() => import("@/pages/tree-track"));
const CoshhTrackPage = lazy(() => import("@/pages/coshh-track"));
const BikeTrackPage = lazy(() => import("@/pages/bike-track"));
const AquaTrackPage = lazy(() => import("@/pages/aqua-track"));
const GreenTrackPage = lazy(() => import("@/pages/green-track"));
const DailyTrackAmPage = lazy(() => import("@/pages/daily-track-am"));
const DailyTrackPmPage = lazy(() => import("@/pages/daily-track-pm"));
const DailyTrackStatusPage = lazy(() => import("@/pages/daily-track-status"));
const StaffRosterPage = lazy(() => import("@/pages/staff-roster"));
const SignOffPage = lazy(() => import("@/pages/sign-off"));
const PrivacyRequestPage = lazy(() => import("@/pages/privacy-request"));
const ContractorPortalPage = lazy(() => import("@/pages/contractor-portal"));
const ContractorApprovalsPage = lazy(() => import("@/pages/contractor-approvals"));
const ContractorQuotePage = lazy(() => import("@/pages/contractor-quote"));
const IncidentsPage = lazy(() => import("@/pages/incidents"));
const PATTrackPage = lazy(() => import("@/pages/pat-track"));
const PestTrackPage = lazy(() => import("@/pages/pest-track"));
const PremisesTrackPage = lazy(() => import("@/pages/premises-track"));
const RoomTrackPage = lazy(() => import("@/pages/room-track"));
const ReportsPage = lazy(() => import("@/pages/reports"));
const ComplianceHubPage = lazy(() => import("@/pages/compliance-hub"));
const FeedbackInboxPage = lazy(() => import("@/pages/feedback-inbox"));
const NotFound = lazy(() => import("@/pages/not-found"));
const DailyOverviewPage = lazy(() => import("@/pages/daily-overview"));
const DailyChecklistPage = lazy(() => import("@/pages/daily-checklist"));
const DocumentsPage = lazy(() => import("@/pages/documents"));
const FoodSafetyPage = lazy(() => import("@/pages/food-safety"));
const DailyHistoryPage = lazy(() => import("@/pages/daily-history"));
const StaffTrainingPage = lazy(() => import("@/pages/staff-training"));
const ClientsPage = lazy(() => import("@/pages/clients"));
const LockedClientsPage = lazy(() => import("@/pages/clients").then(m => ({ default: m.LockedClientsPage })));
const PortfolioPage = lazy(() => import("@/pages/portfolio"));
const SetupPage = lazy(() => import("@/pages/setup"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const CalendarPage = lazy(() => import("@/pages/calendar"));
const WaterSafetyPage = lazy(() => import("@/pages/safety-summary").then(m => ({ default: m.WaterSafetyPage })));
const KioskPage = lazy(() => import("@/pages/staff-kiosk"));
const StaffSetPinPage = lazy(() => import("@/pages/staff-kiosk").then(m => ({ default: m.StaffSetPinPage })));
const ScanPage = lazy(() => import("@/pages/scan"));
const EquipmentPage = lazy(() => import("@/pages/equipment"));
const ReportActionsPage = lazy(() => import("@/pages/report-actions"));

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
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return null;
}

function PageLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-muted-foreground text-sm animate-pulse">Loading...</div>
    </div>
  );
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
      ["/coshh-track", "coshhtrack"],
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
  // Modules, free templates and pricing (see pages/public-site.tsx).
  if (/^\/(pricing|features|templates)(\/[^/]+)?\/?$/.test(location)) return <PublicSitePage location={location} />;
  if (location.startsWith("/verify-email")) return <VerifyEmailPage />;
  if (location.startsWith("/schedule/")) return <SchedulePage />;
  if (location.startsWith("/sign-off/")) return <SignOffPage />;
  if (location.startsWith("/privacy-request/")) return <PrivacyRequestPage />;
  if (location.startsWith("/contractor-portal/")) return <Route path="/contractor-portal/:token" component={ContractorPortalPage} />;
  if (location.startsWith("/contractor-quote/")) return <ContractorQuotePage />;
  if (location === "/kiosk") return <KioskPage />;
  if (location === "/staff/set-pin") return <StaffSetPinPage />;

  if (isLoading) return <PageLoading />;

  if (needsTwoFactorSetup) return <MandatoryTwoFactorPage />;

  // Not logged in
  if (!user) {
    if (location === "/login") return <LoginPage />;
    // Show landing page at root when not logged in
    if (location === "/" || location === "") return <LandingPage />;
    // A scanned equipment label: sign in, then come back to it.
    if (location.startsWith("/q/")) {
      rememberScanPath(location);
      return <Redirect to="/login" />;
    }
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
    // The portfolio read stays open on the server so a consultant can still
    // see and switch between the businesses they manage.
    if (location === "/portfolio" && user.role === "consultant") {
      return <PortfolioPage />;
    }
    return <TrialEndedPage />;
  }

  // A Viewer only ever sees their own training records.
  if (user.role === "client_viewer") {
    // A scanned label tells a Viewer it isn't available rather than bouncing.
    if (location.startsWith("/q/")) return <Route path="/q/:code" component={ScanPage} />;
    if (location !== "/my-training") return <Redirect to="/my-training" />;
    return <MyTrainingPage />;
  }

  // Logged in — redirect away from public pages
  if (location === "/login" || location === "/") {
    const scanPath = pendingScanPath();
    if (scanPath) return <Redirect to={scanPath} />;
    // Back from Stripe Checkout (sessions opened before it returned to
    // /dashboard): straight into the business that was paid for.
    if (readBillingReturn()) return <Redirect to={`/dashboard${window.location.search}`} />;
    // Consultants land on their portfolio, which forwards to the dashboard
    // unless they manage two or more businesses.
    return <Redirect to={user.role === "consultant" ? "/portfolio?from=landing" : "/dashboard"} />;
  }

  const canAdmin = user.role === "consultant" || user.role === "client_admin";
  const canManageUsers = canAdmin || user.role === "client_manager";
  const canManageContractorEmails = canAdmin || user.isMaintenanceManager === true || user.role === "client_manager";
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
      <Route path="/q/:code" component={ScanPage} />
      {canManageUsers && <Route path="/equipment" component={EquipmentPage} />}
      {canManageUsers && <Route path="/report-actions" component={ReportActionsPage} />}
      <Route path="/fire-safety" component={FireSafetyPage} />
      <Route path="/kitchen" component={KitchenPage} />
      <Route path="/allergens" component={AllergensPage} />
      {/* The COSHH register is COSHHTrack's Substances tab. */}
      <Route path="/coshh">{() => <Redirect to="/coshh-track?tab=substances" />}</Route>
      <Route path="/asbestos" component={AsbestosRegisterPage} />
      <Route path="/legionella" component={LegionellaPage} />
      <Route path="/safe-track">{() => <Redirect to="/doc-track" />}</Route>
      <Route path="/fix-track" component={FixTrackPage} />
      <Route path="/fix-track/:id" component={FixTrackDetailPage} />
      <Route path="/doc-track" component={DocTrackPage} />
      <Route path="/train-track" component={TrainTrackPage} />
      <Route path="/hot-tub" component={HotTubPage} />
      <Route path="/tree-track" component={TreeTrackPage} />
      <Route path="/coshh-track" component={CoshhTrackPage} />
      <Route path="/bike-track" component={BikeTrackPage} />
      <Route path="/aqua-track"  component={AquaTrackPage} />
      {/* Legacy URLs redirect to the combined AquaTrack page */}
      <Route path="/pool-track">{() => <Redirect to="/aqua-track" />}</Route>
      <Route path="/swim-track">{() => <Redirect to="/aqua-track" />}</Route>
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
      <Route path="/calendar" component={CalendarPage} />
      <Route path="/compliance-hub" component={ComplianceHubPage} />
      {canAdmin && <Route path="/setup" component={SetupPage} />}
      <Route path="/tasks" component={TasksPage} />
      {canAdmin && <Route path="/sites/:id" component={SiteDetailPage} />}
      {canAdmin && <Route path="/sites" component={SitesPage} />}
      {canAdmin && <Route path="/categories/:id" component={CategoryDetailPage} />}
      {canAdmin && <Route path="/categories" component={CategoriesPage} />}
      {canManageUsers && <Route path="/users" component={UsersPage} />}
      {canAdmin && <Route path="/staff-roster" component={StaffRosterPage} />}
      {canAdmin && <Route path="/feedback" component={FeedbackInboxPage} />}
      {canAdmin && <Route path="/settings" component={SettingsPage} />}
      <Route path="/account-security" component={AccountSecurityPage} />
      {canAdmin && <Route path="/privacy-governance" component={PrivacyGovernancePage} />}
      {isConsultant && <Route path="/clients" component={ClientsPage} />}
      {isConsultant && <Route path="/portfolio" component={PortfolioPage} />}
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
            <Suspense fallback={<PageLoading />}>
              <ProtectedRoutes />
            </Suspense>
          </WouterRouter>
          <OverrideReasonDialog />
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
