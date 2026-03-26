import { Router, type IRouter } from "express";
import healthRouter from "./health";
import categoriesRouter from "./categories";
import complianceItemsRouter from "./compliance-items";

const router: IRouter = Router();

router.use(healthRouter);
router.use(categoriesRouter);
router.use(complianceItemsRouter);

export default router;
