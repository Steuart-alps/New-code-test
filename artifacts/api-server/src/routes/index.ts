import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import clientsRouter from "./clients";
import usersRouter from "./users";
import departmentsRouter from "./departments";
import categoriesRouter from "./categories";
import complianceItemsRouter from "./compliance-items";
import contractorsRouter from "./contractors";
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
import privacyGovernanceRouter from "./privacy-governance";
import dashboardSummaryRouter from "./dashboard-summary";
import complianceHubRouter from "./compliance-hub";
import trackActionsRouter from "./track-actions";
import trackEvidenceRouter from "./track-evidence";
import auditEventsRouter from "./audit-events";
import auditLogRouter from "./audit-log";
import analyticsRouter from "./analytics";
import { requireAuth } from "../middleware/requireAuth";
import { requireService, requireAnyService } from "../lib/services";
import documentsRouter from "./documents";
import { staffTrainingRouter } from "./staff-training";
import dailyChecklistsRouter from "./daily-checklists";
import feedbackRouter from "./feedback";
import { publicLinkRateLimit, publicLinkTokenRateLimit } from "../lib/loginRateLimit";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
// First-party analytics ingest; does its own session check (before root-level auth routers).
router.use(analyticsRouter);
router.use("/billing", billingRouter);
// Signed file download links (bearer tokens; opened without a session).
router.use(storageDownloadRouter);
// Public contractor self-service portal — token-protected, not login-protected.
// Mount before root-level routers that install requireAuth for all later paths.
router.use("/contractor-portal", publicLinkRateLimit, publicLinkTokenRateLimit, contractorPortalRouter);
// Public FixTrack token links must also precede routers with root-level auth.
router.use("/fix-track/action", publicLinkRateLimit, publicLinkTokenRateLimit, fixTrackPublicRouter);
router.use("/fix-track/quotes/public", publicLinkRateLimit, publicLinkTokenRateLimit, fixTrackQuoteRouter);
// Contractor visit-scheduling links (token-protected).
router.use("/notifications/public/schedule", publicLinkRateLimit, publicLinkTokenRateLimit, notificationsPublicRouter);
// Staff document sign-off link (token-protected).
router.use("/sign-off", publicLinkRateLimit, publicLinkTokenRateLimit, signOffRouter);
router.use(adminRouter);
router.use(emailDomainRouter);
router.use(sitesRouter);
router.use(clientsRouter);
router.use(usersRouter);
router.use(departmentsRouter);
router.use(categoriesRouter);
router.use(complianceItemsRouter);
router.use(contractorsRouter);
router.use(certificatesRouter);
router.use(settingsRouter);
router.use(privacyGovernanceRouter);
router.use(notificationsRouter);
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
router.use(checklistTemplatesRouter);
router.use(checkRemindersRouter);
router.use(w3wRouter);
router.use("/incidents", requireAuth, requireService("incidenttrack"), incidentsRouter);
router.use("/pat-track",  requireAuth, requireService("pattrack"),  patTrackRouter);
router.use("/pest-track", requireAuth, requireService("pesttrack"), pestTrackRouter);
router.use("/premises-track", requireAuth, requireService("premisestrack"), premisesTrackRouter);
router.use("/room-track", requireAuth, requireService("roomtrack"), roomTrackRouter);
router.use("/form-options", requireAuth, formOptionsRouter);
router.use(mobileRouter);
router.use(exportRouter);
router.use(reportsRouter);
router.use(dashboardSummaryRouter);
router.use(complianceHubRouter);
router.use(feedbackRouter);
router.use("/audit-events", auditEventsRouter);
router.use("/audit-log", auditLogRouter);
router.use("/track-actions", trackActionsRouter);
router.use("/track-evidence", trackEvidenceRouter);
export default router;
