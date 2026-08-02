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
import kitchenWeeklyRouter from "./kitchen-weekly";
import dailyTrackAmRouter from "./daily-track-am";
import dailyTrackPmRouter from "./daily-track-pm";
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
router.use("/doc-track", requireAuth, requireService("doctrack"), docTrackRouter);
router.use("/train-track", requireAuth, requireService("traintrack"), trainTrackRouter);
router.use("/hot-tub", requireAuth, requireService("hottubtrack"), hotTubRouter);
router.use("/tree-track", requireAuth, requireService("treetrack"), treeTrackRouter);
router.use("/kitchen-weekly", requireAuth, requireService("kitchentrack"), kitchenWeeklyRouter);
// The AM/PM checklists cover both kitchen (kitchentrack) and premises
// (safetrack) opening/closing items, so the router-level gate only requires
// SOME purchased branch; each handler additionally checks the specific
// service that matches the checklistType being read/written.
router.use("/daily-track-am", requireAuth, requireAnyService("kitchentrack", "safetrack"), dailyTrackAmRouter);
router.use("/daily-track-pm", requireAuth, requireAnyService("kitchentrack", "safetrack"), dailyTrackPmRouter);

export default router;
