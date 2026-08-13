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
import notificationsRouter from "./notifications";
import storageRouter from "./storage";
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
import fixTrackPublicRouter from "./fix-track-public";
import incidentsRouter from "./incidents";
import patTrackRouter from "./pat-track";
import pestTrackRouter from "./pest-track";
import premisesTrackRouter from "./premises-track";
import formOptionsRouter from "./form-options";
import mobileRouter from "./mobile";
import exportRouter from "./export";
import { requireAuth } from "../middleware/requireAuth";
import { requireService, requireAnyService } from "../lib/services";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use("/billing", billingRouter);
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
router.use(notificationsRouter);
router.use(storageRouter);
router.use("/food-safety", requireAuth, requireService("kitchentrack"), foodSafetyRouter);
router.use("/fire-safety", requireAuth, requireService("firetrack"), fireSafetyRouter);
router.use("/legionella", requireAuth, requireService("legionellatrack"), legionellaRouter);
router.use("/safe-track", requireAuth, requireService("safetrack"), safeTrackRouter);
router.use("/fix-track", requireAuth, requireService("fixtrack"), fixTrackRouter);
router.use(staffRosterRouter);
router.use("/sign-off", signOffRouter); // public — no auth
// safetrack and doctrack are now the same module; either key grants access.
router.use("/doc-track", requireAuth, requireAnyService("doctrack", "safetrack"), docTrackRouter);
router.use("/train-track", requireAuth, requireService("traintrack"), trainTrackRouter);
router.use("/hot-tub", requireAuth, requireService("hottubtrack"), hotTubRouter);
router.use("/tree-track", requireAuth, requireService("treetrack"), treeTrackRouter);
router.use("/bike-track", requireAuth, requireService("biketrack"), bikeTrackRouter);
router.use("/pool-track",   requireAuth, requireService("pooltrack"),  poolTrackRouter);
router.use("/green-track",  requireAuth, requireService("greentrack"), greenTrackRouter);
router.use("/swim-track",   requireAuth, requireService("swimtrack"),  swimTrackRouter);
router.use("/photos", requireAuth, photosRouter);
router.use("/kitchen-weekly", requireAuth, requireService("kitchentrack"), kitchenWeeklyRouter);
router.use("/kitchen-cleaning", requireAuth, requireService("kitchentrack"), kitchenCleaningRouter);
// The AM/PM checklists cover both kitchen (kitchentrack) and premises
// (safetrack) opening/closing items, so the router-level gate only requires
// SOME purchased branch; each handler additionally checks the specific
// service that matches the checklistType being read/written.
router.use("/daily-track-am", requireAuth, requireAnyService("dailytrack_am", "kitchentrack", "safetrack"), dailyTrackAmRouter);
router.use("/daily-track-pm", requireAuth, requireAnyService("dailytrack_pm", "kitchentrack", "safetrack"), dailyTrackPmRouter);
router.use(checklistTemplatesRouter);
router.use(checkRemindersRouter);
router.use(w3wRouter);
router.use("/incidents", requireAuth, requireService("incidenttrack"), incidentsRouter);
router.use("/pat-track",  requireAuth, requireService("pattrack"),  patTrackRouter);
router.use("/pest-track", requireAuth, requireService("pesttrack"), pestTrackRouter);
router.use("/premises-track", requireAuth, requireService("premisestrack"), premisesTrackRouter);
router.use("/form-options", requireAuth, formOptionsRouter);
router.use(mobileRouter);
router.use(exportRouter);
// Public contractor action links — no auth, token-protected
router.use("/fix-track/action", fixTrackPublicRouter);

export default router;
