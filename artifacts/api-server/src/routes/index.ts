import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import clientsRouter from "./clients";
import usersRouter from "./users";
import departmentsRouter from "./departments";
import categoriesRouter from "./categories";
import complianceItemsRouter from "./compliance-items";
import contractorsRouter from "./contractors";
import contractorVisitsRouter from "./contractor-visits";
import certificatesRouter from "./certificates";
import settingsRouter from "./settings";
import notificationsRouter, { notificationsPublicRouter } from "./notifications";
import storageRouter, { storageDownloadRouter } from "./storage";
import billingRouter from "./billing";
import adminRouter from "./admin";
import emailDomainRouter from "./emailDomain";
import sitesRouter from "./sites";
import foodSafetyRouter from "./food-safety";
import fireSafetyRouter from "./fire-safety";
import legionellaRouter from "./legionella";
import safeTrackRouter from "./safe-track";
import fixTrackRouter from "./fix-track";
import docTrackRouter from "./doc-track";
import trainTrackRouter from "./train-track";
import hotTubRouter from "./hot-tub";
import treeTrackRouter from "./tree-track";
import coshhTrackRouter from "./coshh-track";
import bikeTrackRouter from "./bike-track";
import poolTrackRouter from "./pool-track";
import greenTrackRouter from "./green-track";
import swimTrackRouter from "./swim-track";
import photosRouter from "./photos";
import staffRosterRouter from "./staff-roster";
import signOffRouter from "./sign-off";
import kitchenWeeklyRouter from "./kitchen-weekly";
import kitchenCleaningRouter from "./kitchen-cleaning";
import dailyTrackAmRouter from "./daily-track-am";
import dailyTrackPmRouter from "./daily-track-pm";
import dailyTrackStatusRouter from "./daily-track-status";
import checklistTemplatesRouter from "./checklist-templates";
import checkRemindersRouter from "./check-reminders";
import w3wRouter from "./w3w";
import fixTrackPublicRouter, { fixTrackQuoteRouter } from "./fix-track-public";
import contractorPortalRouter from "./contractor-portal";
import incidentsRouter from "./incidents";
import patTrackRouter from "./pat-track";
import pestTrackRouter from "./pest-track";
import premisesTrackRouter from "./premises-track";
import roomTrackRouter from "./room-track";
import formOptionsRouter from "./form-options";
import mobileRouter from "./mobile";
import exportRouter from "./export";
import reportsRouter from "./reports";
import inspectionPackRouter from "./inspection-pack";
import calendarRouter from "./calendar";
import privacyGovernanceRouter from "./privacy-governance";
import privacyIntakePublicRouter from "./privacy-intake-public";
import dashboardSummaryRouter from "./dashboard-summary";
import dashboardTodayRouter from "./dashboard-today";
import complianceHubRouter from "./compliance-hub";
import trackActionsRouter from "./track-actions";
import trackEvidenceRouter from "./track-evidence";
import auditEventsRouter from "./audit-events";
import auditLogRouter from "./audit-log";
import publicLinkAccessRouter from "./public-link-access";
import analyticsRouter from "./analytics";
import registersRouter from "./registers";
import trackOwnersRouter from "./track-owners";
import userNotificationsRouter from "./user-notifications";

import csvImportsRouter from "./csv-imports";
import consultantPortfolioRouter from "./consultant-portfolio";

import setupRouter from "./setup";
import tasksRouter from "./tasks";
import equipmentRouter from "./equipment";
import { requireAuth } from "../middleware/requireAuth";
import { limitViewers } from "../middleware/viewerScope";
import { requireService, requireAnyService } from "../lib/services";
import documentsRouter from "./documents";
import { staffTrainingRouter } from "./staff-training";
import dailyChecklistsRouter from "./daily-checklists";
import feedbackRouter from "./feedback";
import { publicLinkRateLimits } from "../lib/loginRateLimit";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
// First-party analytics ingest; does its own session check (before root-level auth routers).
router.use(analyticsRouter);
// Viewers reach only their own training records past this point.
router.use(limitViewers);
router.use("/billing", billingRouter);
// Signed file download links (bearer tokens; opened without a session).
router.use(storageDownloadRouter);
// Public contractor self-service portal — token-protected, not login-protected.
// Mount before root-level routers that install requireAuth for all later paths.
router.use("/contractor-portal", publicLinkRateLimits, contractorPortalRouter);
// Public FixTrack token links must also precede routers with root-level auth.
router.use("/fix-track/action", publicLinkRateLimits, fixTrackPublicRouter);
router.use("/fix-track/quotes/public", publicLinkRateLimits, fixTrackQuoteRouter);
// Contractor visit-scheduling links (token-protected).
router.use("/notifications/public/schedule", publicLinkRateLimits, notificationsPublicRouter);
// Staff document sign-off link (token-protected).
router.use("/sign-off", publicLinkRateLimits, signOffRouter);
// Public privacy rights-request form (token-protected).
router.use("/privacy-intake", publicLinkRateLimits, privacyIntakePublicRouter);
router.use(adminRouter);
router.use(emailDomainRouter);
router.use(sitesRouter);
router.use(clientsRouter);
router.use(usersRouter);
router.use(departmentsRouter);
router.use(categoriesRouter);
router.use(complianceItemsRouter);
router.use(contractorsRouter);
router.use(contractorVisitsRouter);
router.use(certificatesRouter);
router.use(settingsRouter);
router.use(privacyGovernanceRouter);
router.use(notificationsRouter);
// In-app notifications (header bell) and track owners; per-route requireAuth.
router.use(userNotificationsRouter);
router.use(trackOwnersRouter);
router.use(storageRouter);
router.use("/food-safety", requireAuth, requireService("kitchentrack"), foodSafetyRouter);
router.use(dailyChecklistsRouter);
router.use(documentsRouter);
router.use(staffTrainingRouter);
router.use("/fire-safety", requireAuth, requireService("firetrack"), fireSafetyRouter);
router.use("/legionella", requireAuth, requireService("legionellatrack"), legionellaRouter);
router.use("/safe-track", requireAuth, requireService("safetrack"), safeTrackRouter);
router.use("/fix-track", requireAuth, (req, res, next) => {
  if (req.path.startsWith("/contractor-email-queue")) return next();
  return requireService("fixtrack")(req, res, next);
}, fixTrackRouter);
router.use(staffRosterRouter);
// safetrack and doctrack are now the same module; either key grants access.
router.use("/doc-track", requireAuth, requireAnyService("doctrack", "safetrack"), docTrackRouter);
router.use("/train-track", requireAuth, requireService("traintrack"), trainTrackRouter);
router.use("/hot-tub", requireAuth, requireService("hottubtrack"), hotTubRouter);
router.use("/tree-track", requireAuth, requireService("treetrack"), treeTrackRouter);
router.use("/bike-track", requireAuth, requireService("biketrack"), bikeTrackRouter);
router.use("/pool-track",   requireAuth, requireAnyService("pooltrack", "aquatrack"),  poolTrackRouter);
router.use("/green-track",  requireAuth, requireService("greentrack"), greenTrackRouter);
router.use("/swim-track",   requireAuth, requireAnyService("swimtrack", "aquatrack"),  swimTrackRouter);
router.use("/photos", requireAuth, photosRouter);
router.use("/kitchen-weekly", requireAuth, requireService("kitchentrack"), kitchenWeeklyRouter);
router.use("/kitchen-cleaning", requireAuth, requireService("kitchentrack"), kitchenCleaningRouter);
// The AM/PM checklists cover both kitchen (kitchentrack) and premises
// (premisestrack) opening/closing items, so the router-level gate only requires
// SOME purchased branch; each handler additionally checks the specific
// service that matches the checklistType being read/written.
router.use("/daily-track-am", requireAuth, requireAnyService("dailytrack_am", "kitchentrack", "premisestrack"), dailyTrackAmRouter);
router.use("/daily-track-pm", requireAuth, requireAnyService("dailytrack_pm", "kitchentrack", "premisestrack"), dailyTrackPmRouter);
// The status page covers both periods, so any AM or PM service opens it; the
// route itself reports which checks those services make the client responsible for.
router.use("/daily-track-status", requireAuth, requireAnyService("dailytrack_am", "dailytrack_pm", "kitchentrack", "premisestrack"), dailyTrackStatusRouter);
router.use(checklistTemplatesRouter);
router.use(checkRemindersRouter);
router.use(w3wRouter);
router.use("/incidents", requireAuth, requireService("incidenttrack"), incidentsRouter);
router.use("/pat-track",  requireAuth, requireService("pattrack"),  patTrackRouter);
router.use("/pest-track", requireAuth, requireService("pesttrack"), pestTrackRouter);
router.use("/premises-track", requireAuth, requireService("premisestrack"), premisesTrackRouter);
router.use("/room-track", requireAuth, requireService("roomtrack"), roomTrackRouter);
// Allergen (KitchenTrack-gated inside), COSHH and asbestos registers.
router.use("/registers", requireAuth, registersRouter);
router.use("/coshh-track", requireAuth, requireService("coshhtrack"), coshhTrackRouter);
router.use("/form-options", requireAuth, formOptionsRouter);
router.use(mobileRouter);
router.use(exportRouter);
router.use(reportsRouter);
router.use(inspectionPackRouter);
router.use(calendarRouter);
router.use(equipmentRouter);
router.use(dashboardSummaryRouter);
router.use(dashboardTodayRouter);
router.use(complianceHubRouter);
router.use(feedbackRouter);
router.use(csvImportsRouter);
router.use(consultantPortfolioRouter);
router.use("/audit-events", auditEventsRouter);
router.use("/audit-log", auditLogRouter);
router.use("/public-link-access", publicLinkAccessRouter);
router.use("/track-actions", trackActionsRouter);
router.use("/track-evidence", trackEvidenceRouter);
router.use(setupRouter, tasksRouter);
export default router;
