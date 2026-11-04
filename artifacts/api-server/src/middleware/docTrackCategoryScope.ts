import type { RequestHandler } from "express";
import { getClientId } from "./requireAuth";
import { getEntitledServices } from "../lib/services";
import { docTrackCategoriesFor } from "../lib/docTrackScope";

/**
 * Sets res.locals.docCategories for the DocTrack routes: the categories the
 * account may use, null meaning all. Mount after the service check.
 */
export const docTrackCategoryScope: RequestHandler = async (req, res, next) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  res.locals.docCategories = docTrackCategoriesFor(await getEntitledServices(clientId));
  next();
};
