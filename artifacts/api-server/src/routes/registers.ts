/**
 * Site registers, mounted at /registers:
 *  - Allergen records (KitchenTrack): dishes/products per site with the 14
 *    regulated allergens, a PPDS flag and an append-only tick change log.
 *  - COSHH register (core): hazardous substances per site with a safety data
 *    sheet, assessment and review dates, controls/PPE and status.
 *  - Asbestos (core): one current record per site (build age, survey, report,
 *    management plan review) plus its register of asbestos-containing
 *    materials; replaced survey reports stay listed in its survey history.
 *
 * Every row belongs to the caller's client (getClientId) and to a site the
 * caller can see: client_staff/client_viewer are limited to sites in their
 * department or with no department, as on GET /sites. Deletes are soft
 * (deleted_at) so nothing is lost. Uploaded documents use the verified
 * finalisation flow (pinned generation, content signature check, immutable
 * copy, tenant ACL) also used for contractor certificates and photos.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  allergenItemsTable,
  allergenItemChangesTable,
  coshhSubstancesTable,
  asbestosRecordsTable,
  asbestosRegisterEntriesTable,
  asbestosSurveyHistoryTable,
  sitesTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { requireAuth, denyViewers, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { requireService } from "../lib/services";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  ObjectOwnershipError,
  ObjectContentError,
  ObjectGenerationError,
  type AllowedUploadType,
} from "../lib/objectStorage";
import { respondObjectStorageDownloadUnavailable, respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";

const router = Router();

// Allergen records are part of KitchenTrack; COSHH and asbestos are core.
router.use("/allergens", requireService("kitchentrack"));

// ── Vocabularies ──────────────────────────────────────────────────────────────

/** The 14 allergens in Schedule 1 of the Food Information Regulations 2014 (retained Regulation (EU) 1169/2011, Annex II). */
export const ALLERGEN_KEYS = [
  "celery", "gluten", "crustaceans", "eggs", "fish", "lupin", "milk",
  "molluscs", "mustard", "tree_nuts", "peanuts", "sesame", "soya", "sulphites",
] as const;

/** GHS hazard pictograms (GB CLP). */
export const GHS_PICTOGRAM_KEYS = [
  "ghs01", "ghs02", "ghs03", "ghs04", "ghs05", "ghs06", "ghs07", "ghs08", "ghs09",
] as const;

const ALLOWED_DOCUMENT_TYPES: ReadonlySet<AllowedUploadType> = new Set(["application/pdf", "image/jpeg", "image/png"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Invalid date");
const TEXT = (max: number) => z.string().trim().max(max);
const OPTIONAL_TEXT = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || null);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus whole calendar months, clamped to the end of the month. */
export function addMonthsIso(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date, lastDay));
  return first.toISOString().slice(0, 10);
}

/** Canonical, de-duplicated order for a set of vocabulary keys. */
function canonical<T extends string>(values: readonly T[], vocabulary: readonly T[]): T[] {
  const chosen = new Set(values);
  return vocabulary.filter((key) => chosen.has(key));
}

function parseId(raw: string | string[] | undefined): number | null {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requireClient(req: Request, res: Response): number | null {
  const clientId = getClientId(req);
  if (!clientId) res.status(400).json({ error: "No client context" });
  return clientId;
}

/**
 * Department scoping for a site_id column: staff/viewers see rows for sites in
 * their department or with no department, plus rows whose site was removed.
 */
function siteScope(req: Request, clientId: number, column: PgColumn): SQL | undefined {
  const deptId = getActiveDepartmentId(req);
  if (deptId === null) return undefined;
  const visibleSites = db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), sitesTableVisibleTo(deptId)));
  return or(isNull(column), inArray(column, visibleSites));
}

/** The site must belong to this client and be visible to the caller. */
async function canUseSite(req: Request, clientId: number, siteId: number): Promise<boolean> {
  const deptId = getActiveDepartmentId(req);
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(
      eq(sitesTable.id, siteId),
      eq(sitesTable.clientId, clientId),
      deptId === null ? undefined : sitesTableVisibleTo(deptId),
    ))
    .limit(1);
  return !!site;
}

function siteFilter(req: Request, column: PgColumn): SQL | undefined | "invalid" {
  if (req.query.siteId === undefined || req.query.siteId === "") return undefined;
  const siteId = parseId(req.query.siteId as string);
  return siteId === null ? "invalid" : eq(column, siteId);
}

const storage = new ObjectStorageService();

/**
 * Turns a just-uploaded staging object into an immutable, content-checked,
 * tenant-owned file. Sends the error response and returns null on failure.
 */
async function finalizeDocument(req: Request, res: Response, objectPath: string, clientId: number) {
  try {
    return await storage.finalizeVerifiedTenantUpload(objectPath, clientId, ALLOWED_DOCUMENT_TYPES);
  } catch (err) {
    // Rejected objects never received a tenant ACL; remove them best-effort.
    await storage.discardTenantUpload(objectPath, clientId).catch(() => {});
    if (!(err instanceof ObjectNotFoundError || err instanceof ObjectOwnershipError
      || err instanceof ObjectContentError || err instanceof ObjectGenerationError)) {
      req.log.error({ err }, "Could not finalise register document upload");
    }
    const error = err instanceof ObjectNotFoundError ? "Uploaded file not found"
      : err instanceof ObjectContentError ? "The file must be a PDF, JPEG or PNG"
      : err instanceof ObjectGenerationError ? err.message
      : err instanceof ObjectOwnershipError ? err.message : "Could not secure the uploaded file";
    res.status(err instanceof ObjectNotFoundError ? 404
      : err instanceof ObjectContentError ? 400
      : err instanceof ObjectGenerationError ? 409 : 403).json({ error });
    return null;
  }
}

async function sendDownloadUrl(req: Request, res: Response, objectPath: string | null, fileName: string | null, clientId: number, recordId: number) {
  if (!objectPath) return res.status(404).json({ error: "No file attached" });
  try {
    const downloadUrl = await storage.getSignedDownloadURL(objectPath, 900, ALLOWED_DOCUMENT_TYPES, clientId);
    return res.json({ downloadUrl, fileName });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "File not found" });
    if (err instanceof ObjectOwnershipError) return res.status(403).json({ error: "File is not available for this account" });
    if (err instanceof ObjectContentError) return res.status(409).json({ error: "File failed its content check" });
    return respondObjectStorageDownloadUnavailable(req, res, err, "register document download", { recordId, clientId });
  }
}

const documentFields = {
  objectPath: z.string().min(1).max(2000).nullish(),
  fileName: OPTIONAL_TEXT(500),
};

// Presigned upload for a safety data sheet or survey report.
router.post("/uploads/request-url", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = z.object({ contentType: z.string().max(100) }).safeParse(req.body);
  const contentType = parsed.success ? parsed.data.contentType.toLowerCase() : "";
  if (!ALLOWED_DOCUMENT_TYPES.has(contentType as AllowedUploadType)) {
    return res.status(400).json({ error: "Upload a PDF, JPEG or PNG file" });
  }
  try {
    const uploadUrl = await storage.getObjectEntityUploadURL(clientId, contentType);
    res.json({ uploadUrl, objectPath: storage.normalizeObjectEntityPath(uploadUrl) });
  } catch (err) {
    return respondObjectStorageUnavailable(req, res, err, "register document upload");
  }
});

/**
 * Resolves the document fields for a create/update. An unchanged path keeps
 * the stored file; null detaches it (the stored object is kept); a new path
 * must be a fresh upload for this client and is verified and finalised.
 */
async function resolveDocument(
  req: Request, res: Response, clientId: number,
  input: { objectPath?: string | null; fileName?: string | null },
  existing: { objectPath: string | null; fileName: string | null; fileSize: number | null; mimeType: string | null } | null,
): Promise<{ objectPath: string | null; fileName: string | null; fileSize: number | null; mimeType: string | null } | "kept" | null> {
  if (input.objectPath === undefined) return existing ? "kept" : { objectPath: null, fileName: null, fileSize: null, mimeType: null };
  if (input.objectPath === null) return { objectPath: null, fileName: null, fileSize: null, mimeType: null };
  if (existing && input.objectPath === existing.objectPath) return "kept";
  const finalized = await finalizeDocument(req, res, input.objectPath, clientId);
  if (!finalized) return null;
  let size = NaN;
  try {
    const [metadata] = await (await storage.getObjectEntityFile(finalized.objectPath)).getMetadata();
    size = Number(metadata.size);
  } catch {
    // The size is display-only; the file itself is already secured.
  }
  return {
    objectPath: finalized.objectPath,
    fileName: input.fileName ?? "document",
    fileSize: Number.isSafeInteger(size) && size > 0 ? size : null,
    mimeType: finalized.contentType,
  };
}

// ── Allergen records (KitchenTrack) ───────────────────────────────────────────

const AllergenBody = z.object({
  siteId: z.number().int().positive(),
  name: TEXT(200).min(1, "Name is required"),
  description: OPTIONAL_TEXT(2000),
  allergens: z.array(z.enum(ALLERGEN_KEYS)).max(ALLERGEN_KEYS.length),
  ppds: z.boolean().optional().default(false),
  lastReviewedAt: DATE.nullish(),
  reviewedBy: OPTIONAL_TEXT(200),
  // Required when the allergen ticks change on an edit (recipe or supplier change).
  changeReason: OPTIONAL_TEXT(1000),
});

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

function actorName(req: Request): string | null {
  return req.currentUser?.name ?? null;
}

router.get("/allergens", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, allergenItemsTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const rows = await db.select().from(allergenItemsTable)
    .where(and(
      eq(allergenItemsTable.clientId, clientId),
      isNull(allergenItemsTable.deletedAt),
      siteScope(req, clientId, allergenItemsTable.siteId),
      site,
    ))
    .orderBy(asc(allergenItemsTable.name), asc(allergenItemsTable.id));
  res.json(rows);
});

/** Loads a live allergen item the caller can see, or null. */
async function findAllergenItem(req: Request, clientId: number, id: number, executor: Pick<typeof db, "select"> = db, lock = false) {
  const query = executor.select().from(allergenItemsTable)
    .where(and(
      eq(allergenItemsTable.id, id),
      eq(allergenItemsTable.clientId, clientId),
      isNull(allergenItemsTable.deletedAt),
      siteScope(req, clientId, allergenItemsTable.siteId),
    ))
    .limit(1);
  const [row] = lock ? await query.for("update", { of: allergenItemsTable }) : await query;
  return row ?? null;
}

router.get("/allergens/:id/changes", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  // The change log stays readable after an item is removed.
  const [item] = await db.select({ id: allergenItemsTable.id }).from(allergenItemsTable)
    .where(and(eq(allergenItemsTable.id, id), eq(allergenItemsTable.clientId, clientId), siteScope(req, clientId, allergenItemsTable.siteId)))
    .limit(1);
  if (!item) return res.status(404).json({ error: "Not found" });
  const rows = await db.select().from(allergenItemChangesTable)
    .where(and(eq(allergenItemChangesTable.itemId, id), eq(allergenItemChangesTable.clientId, clientId)))
    .orderBy(desc(allergenItemChangesTable.createdAt), desc(allergenItemChangesTable.id));
  res.json(rows);
});

router.post("/allergens", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = AllergenBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const allergens = canonical(d.allergens, ALLERGEN_KEYS);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(allergenItemsTable).values({
      clientId,
      siteId: d.siteId,
      name: d.name,
      description: d.description,
      allergens,
      ppds: d.ppds,
      lastReviewedAt: d.lastReviewedAt ?? null,
      reviewedBy: d.reviewedBy,
      createdBy: req.currentUser!.id,
    }).returning();
    await tx.insert(allergenItemChangesTable).values({
      clientId,
      itemId: created.id,
      changeType: "created",
      allergensBefore: null,
      allergensAfter: allergens,
      reason: d.changeReason,
      changedBy: req.currentUser!.id,
      changedByName: actorName(req),
    });
    return created;
  });
  res.status(201).json(row);
});

router.put("/allergens/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = AllergenBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await findAllergenItem(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const allergens = canonical(d.allergens, ALLERGEN_KEYS);

  const outcome = await db.transaction(async (tx) => {
    // Lock the row so the logged "before" set is the one actually replaced.
    const existing = await findAllergenItem(req, clientId, id, tx, true);
    if (!existing) return { status: 404 as const };
    const changed = !sameSet(existing.allergens ?? [], allergens);
    if (changed && !d.changeReason) return { status: 400 as const };
    const [updated] = await tx.update(allergenItemsTable).set({
      siteId: d.siteId,
      name: d.name,
      description: d.description,
      allergens,
      ppds: d.ppds,
      lastReviewedAt: d.lastReviewedAt ?? null,
      reviewedBy: d.reviewedBy,
      updatedAt: new Date(),
    }).where(and(eq(allergenItemsTable.id, id), eq(allergenItemsTable.clientId, clientId))).returning();
    if (changed) {
      await tx.insert(allergenItemChangesTable).values({
        clientId,
        itemId: id,
        changeType: "allergens_changed",
        allergensBefore: existing.allergens ?? [],
        allergensAfter: allergens,
        reason: d.changeReason,
        changedBy: req.currentUser!.id,
        changedByName: actorName(req),
      });
    }
    return { status: 200 as const, row: updated };
  });
  if (outcome.status === 404) return res.status(404).json({ error: "Not found" });
  if (outcome.status === 400) {
    return res.status(400).json({ error: "Say what changed (recipe or supplier) when the allergens change" });
  }
  res.json(outcome.row);
});

router.delete("/allergens/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const found = await db.transaction(async (tx) => {
    const existing = await findAllergenItem(req, clientId, id, tx, true);
    if (!existing) return false;
    await tx.update(allergenItemsTable).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(allergenItemsTable.id, id), eq(allergenItemsTable.clientId, clientId)));
    await tx.insert(allergenItemChangesTable).values({
      clientId,
      itemId: id,
      changeType: "removed",
      allergensBefore: existing.allergens ?? [],
      allergensAfter: null,
      changedBy: req.currentUser!.id,
      changedByName: actorName(req),
    });
    return true;
  });
  if (!found) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

// ── COSHH register (core) ─────────────────────────────────────────────────────

const COSHH_STATUSES = ["in_use", "withdrawn"] as const;

const CoshhBody = z.object({
  siteId: z.number().int().positive(),
  productName: TEXT(200).min(1, "Product name is required"),
  supplier: OPTIONAL_TEXT(200),
  hazardPictograms: z.array(z.enum(GHS_PICTOGRAM_KEYS)).max(GHS_PICTOGRAM_KEYS.length).optional().default([]),
  whereUsed: OPTIONAL_TEXT(1000),
  assessmentDate: DATE.nullish(),
  // Omitted on create: 12 months after the assessment date (editable).
  reviewDue: DATE.nullish(),
  controls: OPTIONAL_TEXT(4000),
  status: z.enum(COSHH_STATUSES).optional().default("in_use"),
  ...documentFields,
});

function withCoshhStatus<T extends { reviewDue: string | null; status: string }>(row: T) {
  return { ...row, reviewOverdue: row.status === "in_use" && !!row.reviewDue && row.reviewDue < todayIso() };
}

async function findCoshh(req: Request, clientId: number, id: number) {
  const [row] = await db.select().from(coshhSubstancesTable)
    .where(and(
      eq(coshhSubstancesTable.id, id),
      eq(coshhSubstancesTable.clientId, clientId),
      isNull(coshhSubstancesTable.deletedAt),
      siteScope(req, clientId, coshhSubstancesTable.siteId),
    ))
    .limit(1);
  return row ?? null;
}

router.get("/coshh", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, coshhSubstancesTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const rows = await db.select().from(coshhSubstancesTable)
    .where(and(
      eq(coshhSubstancesTable.clientId, clientId),
      isNull(coshhSubstancesTable.deletedAt),
      siteScope(req, clientId, coshhSubstancesTable.siteId),
      site,
    ))
    .orderBy(asc(coshhSubstancesTable.productName), asc(coshhSubstancesTable.id));
  res.json(rows.map(withCoshhStatus));
});

router.post("/coshh", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = CoshhBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const document = await resolveDocument(req, res, clientId, d, null);
  if (!document || document === "kept") return;
  const reviewDue = d.reviewDue !== undefined ? d.reviewDue : d.assessmentDate ? addMonthsIso(d.assessmentDate, 12) : null;
  const [row] = await db.insert(coshhSubstancesTable).values({
    clientId,
    siteId: d.siteId,
    productName: d.productName,
    supplier: d.supplier,
    hazardPictograms: canonical(d.hazardPictograms, GHS_PICTOGRAM_KEYS),
    whereUsed: d.whereUsed,
    sdsObjectPath: document.objectPath,
    sdsFileName: document.fileName,
    sdsFileSize: document.fileSize,
    sdsMimeType: document.mimeType,
    assessmentDate: d.assessmentDate ?? null,
    reviewDue,
    controls: d.controls,
    status: d.status,
    createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(withCoshhStatus(row));
});

router.put("/coshh/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = CoshhBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  const existing = await findCoshh(req, clientId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const document = await resolveDocument(req, res, clientId, d, {
    objectPath: existing.sdsObjectPath, fileName: existing.sdsFileName,
    fileSize: existing.sdsFileSize, mimeType: existing.sdsMimeType,
  });
  if (!document) return;
  const [row] = await db.update(coshhSubstancesTable).set({
    siteId: d.siteId,
    productName: d.productName,
    supplier: d.supplier,
    hazardPictograms: canonical(d.hazardPictograms, GHS_PICTOGRAM_KEYS),
    whereUsed: d.whereUsed,
    ...(document === "kept" ? {} : {
      sdsObjectPath: document.objectPath,
      sdsFileName: document.fileName,
      sdsFileSize: document.fileSize,
      sdsMimeType: document.mimeType,
    }),
    assessmentDate: d.assessmentDate ?? null,
    ...(d.reviewDue !== undefined ? { reviewDue: d.reviewDue } : {}),
    controls: d.controls,
    status: d.status,
    updatedAt: new Date(),
  }).where(and(eq(coshhSubstancesTable.id, id), eq(coshhSubstancesTable.clientId, clientId), isNull(coshhSubstancesTable.deletedAt))).returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(withCoshhStatus(row));
});

router.delete("/coshh/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findCoshh(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  await db.update(coshhSubstancesTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(coshhSubstancesTable.id, id), eq(coshhSubstancesTable.clientId, clientId)));
  res.status(204).end();
});

router.get("/coshh/:id/sds-url", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const row = await findCoshh(req, clientId, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  return sendDownloadUrl(req, res, row.sdsObjectPath, row.sdsFileName, clientId, id);
});

// ── Asbestos (core) ───────────────────────────────────────────────────────────

const BUILT_BEFORE_2000 = ["yes", "no", "unknown"] as const;
const SURVEY_TYPES = ["management", "refurbishment_demolition"] as const;
const CONDITIONS = ["good", "low_damage", "medium_damage", "high_damage"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;
const ACTIONS = ["manage", "encapsulate", "remove"] as const;

const AsbestosBody = z.object({
  siteId: z.number().int().positive(),
  builtBefore2000: z.enum(BUILT_BEFORE_2000),
  noAsbestosExpected: z.boolean().optional().default(false),
  surveyType: z.enum(SURVEY_TYPES).nullish(),
  surveyDate: DATE.nullish(),
  surveyor: OPTIONAL_TEXT(200),
  // Omitted on create: 12 months after the survey date (or today).
  planReviewDue: DATE.nullish(),
  notes: OPTIONAL_TEXT(4000),
  ...documentFields,
}).refine((d) => !d.noAsbestosExpected || d.builtBefore2000 === "no", {
  message: "\"No asbestos expected\" applies only to buildings built in or after 2000",
});

const EntryBody = z.object({
  location: TEXT(300).min(1, "Location is required"),
  material: TEXT(300).min(1, "Material is required"),
  condition: z.enum(CONDITIONS),
  riskScore: z.number().int().min(0).max(24).nullish(),
  priority: z.enum(PRIORITIES),
  action: z.enum(ACTIONS),
  lastInspected: DATE.nullish(),
  notes: OPTIONAL_TEXT(2000),
});

function withPlanStatus<T extends { planReviewDue: string | null; noAsbestosExpected: boolean }>(row: T) {
  return { ...row, planReviewOverdue: !row.noAsbestosExpected && !!row.planReviewDue && row.planReviewDue < todayIso() };
}

async function findAsbestosRecord(req: Request, clientId: number, id: number) {
  const [row] = await db.select().from(asbestosRecordsTable)
    .where(and(
      eq(asbestosRecordsTable.id, id),
      eq(asbestosRecordsTable.clientId, clientId),
      isNull(asbestosRecordsTable.deletedAt),
      siteScope(req, clientId, asbestosRecordsTable.siteId),
    ))
    .limit(1);
  return row ?? null;
}

function isUniqueViolation(err: any): boolean {
  return (err?.code ?? err?.cause?.code) === "23505";
}

router.get("/asbestos", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, asbestosRecordsTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const records = await db.select().from(asbestosRecordsTable)
    .where(and(
      eq(asbestosRecordsTable.clientId, clientId),
      isNull(asbestosRecordsTable.deletedAt),
      siteScope(req, clientId, asbestosRecordsTable.siteId),
      site,
    ))
    .orderBy(asc(asbestosRecordsTable.id));
  const entries = records.length === 0 ? [] : await db.select().from(asbestosRegisterEntriesTable)
    .where(and(
      eq(asbestosRegisterEntriesTable.clientId, clientId),
      isNull(asbestosRegisterEntriesTable.deletedAt),
      inArray(asbestosRegisterEntriesTable.recordId, records.map((record) => record.id)),
    ))
    .orderBy(asc(asbestosRegisterEntriesTable.location), asc(asbestosRegisterEntriesTable.id));
  const history = records.length === 0 ? [] : await db.select().from(asbestosSurveyHistoryTable)
    .where(and(
      eq(asbestosSurveyHistoryTable.clientId, clientId),
      inArray(asbestosSurveyHistoryTable.recordId, records.map((record) => record.id)),
    ))
    .orderBy(desc(asbestosSurveyHistoryTable.replacedAt), desc(asbestosSurveyHistoryTable.id));
  res.json(records.map((record) => ({
    ...withPlanStatus(record),
    entries: entries.filter((entry) => entry.recordId === record.id),
    surveyHistory: history.filter((survey) => survey.recordId === record.id),
  })));
});

router.post("/asbestos", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = AsbestosBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const document = await resolveDocument(req, res, clientId, d, null);
  if (!document || document === "kept") return;
  const planReviewDue = d.planReviewDue !== undefined ? d.planReviewDue
    : d.noAsbestosExpected ? null : addMonthsIso(d.surveyDate ?? todayIso(), 12);
  try {
    const [row] = await db.insert(asbestosRecordsTable).values({
      clientId,
      siteId: d.siteId,
      builtBefore2000: d.builtBefore2000,
      noAsbestosExpected: d.noAsbestosExpected,
      surveyType: d.surveyType ?? null,
      surveyDate: d.surveyDate ?? null,
      surveyor: d.surveyor,
      reportObjectPath: document.objectPath,
      reportFileName: document.fileName,
      reportFileSize: document.fileSize,
      reportMimeType: document.mimeType,
      planReviewDue,
      notes: d.notes,
      createdBy: req.currentUser!.id,
    }).returning();
    res.status(201).json({ ...withPlanStatus(row), entries: [], surveyHistory: [] });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: "This site already has an asbestos record; edit that one instead" });
    throw err;
  }
});

router.put("/asbestos/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = AsbestosBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  const existing = await findAsbestosRecord(req, clientId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const document = await resolveDocument(req, res, clientId, d, {
    objectPath: existing.reportObjectPath, fileName: existing.reportFileName,
    fileSize: existing.reportFileSize, mimeType: existing.reportMimeType,
  });
  if (!document) return;
  try {
    const row = await db.transaction(async (tx) => {
      // Lock the record so concurrent replacements each archive the report
      // they actually replaced.
      const [current] = await tx.select().from(asbestosRecordsTable)
        .where(and(eq(asbestosRecordsTable.id, id), eq(asbestosRecordsTable.clientId, clientId), isNull(asbestosRecordsTable.deletedAt)))
        .for("update");
      if (!current) return null;
      // A replaced or detached report moves to the survey history with the
      // survey details it was recorded against, so the old file stays listed.
      if (document !== "kept" && current.reportObjectPath && document.objectPath !== current.reportObjectPath) {
        await tx.insert(asbestosSurveyHistoryTable).values({
          clientId,
          recordId: id,
          surveyType: current.surveyType,
          surveyDate: current.surveyDate,
          surveyor: current.surveyor,
          reportObjectPath: current.reportObjectPath,
          reportFileName: current.reportFileName,
          reportFileSize: current.reportFileSize,
          reportMimeType: current.reportMimeType,
          replacedBy: req.currentUser!.id,
        });
      }
      const [updated] = await tx.update(asbestosRecordsTable).set({
        siteId: d.siteId,
        builtBefore2000: d.builtBefore2000,
        noAsbestosExpected: d.noAsbestosExpected,
        surveyType: d.surveyType ?? null,
        surveyDate: d.surveyDate ?? null,
        surveyor: d.surveyor,
        ...(document === "kept" ? {} : {
          reportObjectPath: document.objectPath,
          reportFileName: document.fileName,
          reportFileSize: document.fileSize,
          reportMimeType: document.mimeType,
        }),
        ...(d.planReviewDue !== undefined ? { planReviewDue: d.planReviewDue } : {}),
        notes: d.notes,
        updatedAt: new Date(),
      }).where(and(eq(asbestosRecordsTable.id, id), eq(asbestosRecordsTable.clientId, clientId))).returning();
      return updated ?? null;
    });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(withPlanStatus(row));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: "That site already has an asbestos record" });
    throw err;
  }
});

router.delete("/asbestos/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findAsbestosRecord(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  await db.update(asbestosRecordsTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(asbestosRecordsTable.id, id), eq(asbestosRecordsTable.clientId, clientId)));
  res.status(204).end();
});

router.get("/asbestos/:id/report-url", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const row = await findAsbestosRecord(req, clientId, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  return sendDownloadUrl(req, res, row.reportObjectPath, row.reportFileName, clientId, id);
});

router.get("/asbestos/:id/history/:historyId/report-url", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  const historyId = parseId(req.params.historyId);
  if (id === null || historyId === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findAsbestosRecord(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  const [survey] = await db.select().from(asbestosSurveyHistoryTable)
    .where(and(
      eq(asbestosSurveyHistoryTable.id, historyId),
      eq(asbestosSurveyHistoryTable.recordId, id),
      eq(asbestosSurveyHistoryTable.clientId, clientId),
    ))
    .limit(1);
  if (!survey) return res.status(404).json({ error: "Not found" });
  return sendDownloadUrl(req, res, survey.reportObjectPath, survey.reportFileName, clientId, id);
});

router.post("/asbestos/:id/entries", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = EntryBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  if (!(await findAsbestosRecord(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  const d = parsed.data;
  const [row] = await db.insert(asbestosRegisterEntriesTable).values({
    clientId,
    recordId: id,
    location: d.location,
    material: d.material,
    condition: d.condition,
    riskScore: d.riskScore ?? null,
    priority: d.priority,
    action: d.action,
    lastInspected: d.lastInspected ?? null,
    notes: d.notes,
    createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(row);
});

/** A live entry whose live parent record the caller can see. */
async function findEntry(req: Request, clientId: number, entryId: number) {
  const [entry] = await db.select().from(asbestosRegisterEntriesTable)
    .where(and(
      eq(asbestosRegisterEntriesTable.id, entryId),
      eq(asbestosRegisterEntriesTable.clientId, clientId),
      isNull(asbestosRegisterEntriesTable.deletedAt),
    ))
    .limit(1);
  if (!entry || !(await findAsbestosRecord(req, clientId, entry.recordId))) return null;
  return entry;
}

router.put("/asbestos/entries/:entryId", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const entryId = parseId(req.params.entryId);
  if (entryId === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = EntryBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  if (!(await findEntry(req, clientId, entryId))) return res.status(404).json({ error: "Not found" });
  const d = parsed.data;
  const [row] = await db.update(asbestosRegisterEntriesTable).set({
    location: d.location,
    material: d.material,
    condition: d.condition,
    riskScore: d.riskScore ?? null,
    priority: d.priority,
    action: d.action,
    lastInspected: d.lastInspected ?? null,
    notes: d.notes,
    updatedAt: new Date(),
  }).where(and(eq(asbestosRegisterEntriesTable.id, entryId), eq(asbestosRegisterEntriesTable.clientId, clientId), isNull(asbestosRegisterEntriesTable.deletedAt))).returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/asbestos/entries/:entryId", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const entryId = parseId(req.params.entryId);
  if (entryId === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findEntry(req, clientId, entryId))) return res.status(404).json({ error: "Not found" });
  await db.update(asbestosRegisterEntriesTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(asbestosRegisterEntriesTable.id, entryId), eq(asbestosRegisterEntriesTable.clientId, clientId)));
  res.status(204).end();
});

export default router;
