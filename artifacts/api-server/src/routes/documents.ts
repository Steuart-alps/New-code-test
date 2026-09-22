import { Router } from "express";
import { Readable } from "stream";
import { z } from "zod";
import { db } from "@workspace/db";
import { clientDocumentsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth, getClientId, canAccessClient } from "../middleware/requireAuth";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  ObjectOwnershipError,
} from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";
import { createDownloadMeter } from "../lib/downloadUsage";

const router = Router();
const storage = new ObjectStorageService();

// ── List documents for the current client ────────────────────────────────────

router.get("/documents", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const docs = await db
    .select()
    .from(clientDocumentsTable)
    .where(eq(clientDocumentsTable.clientId, clientId))
    .orderBy(clientDocumentsTable.createdAt);

  res.json(docs);
});

// ── Register a document after the client has uploaded it to object storage ───
// Body: { name, description?, objectPath, fileSize?, mimeType? }

const CreateDocBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional().nullable(),
  objectPath: z.string().min(1),
  fileSize: z.number().int().positive().optional().nullable(),
  mimeType: z.string().optional().nullable(),
});

router.post("/documents", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  // Only consultants and client admins may upload
  if (!["consultant", "client_admin"].includes(user.role)) {
    res.status(403).json({ error: "Only managers can upload documents" });
    return;
  }

  const parsed = CreateDocBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { name, description, objectPath, fileSize, mimeType } = parsed.data;

  try {
    // Registration is the point at which a presigned upload becomes a tenant
    // document. Finalize first so a caller cannot attach another tenant's
    // object path to this client's database row.
    await storage.finalizeTenantUpload(objectPath, clientId);
  } catch (err) {
    if (err instanceof ObjectOwnershipError) {
      res.status(403).json({ error: "Object does not belong to this client" });
      return;
    }
    req.log.error({ err }, "Could not finalize document upload");
    res.status(400).json({ error: "Uploaded file could not be verified" });
    return;
  }

  const [doc] = await db.insert(clientDocumentsTable).values({
    clientId,
    name,
    description: description ?? null,
    objectPath,
    fileSize: fileSize ?? null,
    mimeType: mimeType ?? null,
    uploadedById: user.id,
    uploadedByName: user.name,
  }).returning();

  res.status(201).json(doc);
});

// ── Update document metadata ──────────────────────────────────────────────────

const UpdateDocBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional().nullable(),
});

router.patch("/documents/:id", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  if (!["consultant", "client_admin"].includes(user.role)) {
    res.status(403).json({ error: "Only managers can edit documents" });
    return;
  }

  const [doc] = await db
    .select()
    .from(clientDocumentsTable)
    .where(
      and(
        eq(clientDocumentsTable.id, Number(req.params.id)),
        eq(clientDocumentsTable.clientId, clientId),
      ),
    );

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const parsed = UpdateDocBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const [updated] = await db
    .update(clientDocumentsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(clientDocumentsTable.id, doc.id))
    .returning();

  res.json(updated);
});

// ── Delete a document (removes DB record; object storage is cleaned by GC) ───

router.delete("/documents/:id", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  if (!["consultant", "client_admin"].includes(user.role)) {
    res.status(403).json({ error: "Only managers can delete documents" });
    return;
  }

  const [doc] = await db
    .select()
    .from(clientDocumentsTable)
    .where(
      and(
        eq(clientDocumentsTable.id, Number(req.params.id)),
        eq(clientDocumentsTable.clientId, clientId),
      ),
    );

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  await db.delete(clientDocumentsTable).where(eq(clientDocumentsTable.id, doc.id));
  res.status(204).end();
});

// ── Download / stream a document ─────────────────────────────────────────────

router.get("/documents/:id/download", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const [doc] = await db
    .select()
    .from(clientDocumentsTable)
    .where(
      and(
        eq(clientDocumentsTable.id, Number(req.params.id)),
        eq(clientDocumentsTable.clientId, clientId),
      ),
    );

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  try {
    const file = await storage.getObjectEntityFile(doc.objectPath);
    const canRead = await storage.canAccessObjectEntity({
      userId: String(clientId),
      objectFile: file,
      requestedPermission: ObjectPermission.READ,
    });
    if (!canRead) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const [metadata] = await file.getMetadata();
    const rawRange = req.header("range");
    let range: { start: number; end: number } | undefined;
    if (rawRange) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange.trim());
      const size = Number(metadata.size);
      if (!match || (!match[1] && !match[2])) { res.status(416).setHeader("Content-Range", `bytes */${size}`).end(); return; }
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).end(); return;
      }
      range = { start, end };
    }
    const response = await storage.downloadObject(file, 0 /* no cache for private docs */, range);

    // Force a download with the original filename
    const safeName = doc.name.replace(/[^a-zA-Z0-9._\- ]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "content-disposition") res.setHeader(key, value);
    });

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      const meter = createDownloadMeter(clientId);
      nodeStream.on("data", (chunk) => meter.add(chunk));
      const commit = () => { void meter.commit().catch((error) => req.log.error({ err: error }, "Could not record download usage")); };
      nodeStream.once("end", commit);
      nodeStream.once("close", commit);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found in storage" });
      return;
    }
    req.log.error({ err }, "Error streaming document");
    res.status(500).json({ error: "Failed to download document" });
  }
});

export default router;
