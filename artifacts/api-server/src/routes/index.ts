import { Router, type IRouter } from "express";
import healthRouter from "./health";
import categoriesRouter from "./categories";
import complianceItemsRouter from "./compliance-items";
import contractorsRouter from "./contractors";
import certificatesRouter from "./certificates";
import settingsRouter from "./settings";
import notificationsRouter from "./notifications";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(categoriesRouter);
router.use(complianceItemsRouter);
router.use(contractorsRouter);
router.use(certificatesRouter);
router.use(settingsRouter);
router.use(notificationsRouter);
router.use("/storage", storageRouter);

export default router;
