// Public privacy rights-request form, mounted at /privacy-intake. The link
// token is the only credential: it maps to one business through a stored
// digest, so the URL never carries a client id. Submissions arrive as
// unverified requests for that business's administrators to review.
import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { auditEventsTable, clientsTable, privacyProgramsTable, privacyRightsRequestsTable } from "@workspace/db/schema";
import { digestBearerToken } from "../lib/bearerTokens";
import { privacyIntakeLinkSubmitRateLimit, privacyIntakeSubmitRateLimit } from "../lib/loginRateLimit";
import {
  INTAKE_TOKEN_PATTERN,
  addCalendarMonth,
  newPublicReference,
  notifyPrivacyAdministrators,
  privacyAdministrators,
} from "../lib/privacyIntake";

const router = Router();

const REQUEST_TYPES = ["access", "rectification", "erasure", "restriction", "portability", "objection", "other"] as const;

const SubmissionBody = z.object({
  requestType: z.enum(REQUEST_TYPES),
  name: z.string().trim().min(1, "Enter your name").max(200),
  email: z.string().trim().max(320).email("Enter a valid email address"),
  details: z.string().trim().min(1, "Describe your request").max(5_000),
  // Hidden from people; automated form-fillers tend to complete it.
  website: z.string().max(500).optional(),
});

async function resolveForm(req: Request) {
  const token = String(req.params.token ?? "");
  if (!INTAKE_TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select({
      clientId: privacyProgramsTable.clientId,
      controllerName: privacyProgramsTable.controllerName,
      noticeUrl: privacyProgramsTable.noticeUrl,
      assigneeId: privacyProgramsTable.intakeAssigneeId,
      businessName: clientsTable.name,
    })
    .from(privacyProgramsTable)
    .innerJoin(clientsTable, eq(clientsTable.id, privacyProgramsTable.clientId))
    .where(and(eq(privacyProgramsTable.intakeTokenHash, digestBearerToken(token)), eq(clientsTable.active, true)))
    .limit(1);
  if (!row) return null;
  return { ...row, organisationName: row.controllerName?.trim() || row.businessName };
}

router.get("/:token", async (req, res) => {
  const form = await resolveForm(req);
  if (!form) return res.status(404).json({ error: "This privacy request link is not active" });
  res.json({
    organisationName: form.organisationName,
    privacyNoticeUrl: form.noticeUrl,
    requestTypes: REQUEST_TYPES,
  });
});

router.post("/:token", privacyIntakeSubmitRateLimit, privacyIntakeLinkSubmitRateLimit, async (req, res) => {
  const form = await resolveForm(req);
  if (!form) return res.status(404).json({ error: "This privacy request link is not active" });
  const parsed = SubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Check the form and try again",
      details: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    });
  }
  const body = parsed.data;
  const receivedAt = new Date();
  const dueAt = addCalendarMonth(receivedAt);

  if (body.website?.trim()) {
    // Look the same as a real submission so the filler learns nothing.
    return res.status(201).json({ reference: newPublicReference(), receivedAt });
  }

  // The assignee is only used while they can still manage this business.
  const administrators = form.assigneeId ? await privacyAdministrators(form.clientId) : [];
  const assigneeId = form.assigneeId && administrators.some((admin) => admin.id === form.assigneeId)
    ? form.assigneeId
    : null;

  let created: { id: number; publicReference: string } | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    try {
      created = await db.transaction(async (tx) => {
        const [row] = await tx.insert(privacyRightsRequestsTable).values({
          clientId: form.clientId,
          requestType: body.requestType,
          subjectName: body.name,
          subjectContact: body.email,
          scopeDescription: body.details,
          receivedAt,
          dueAt,
          identityStatus: "not_started",
          status: "received",
          source: "public_intake",
          publicReference: newPublicReference(),
          assignedTo: assigneeId,
        }).returning({ id: privacyRightsRequestsTable.id, publicReference: privacyRightsRequestsTable.publicReference });
        // Subject details stay on the request row; the audit stream only
        // records that an online request of this type arrived.
        await tx.insert(auditEventsTable).values({
          clientId: form.clientId,
          actorId: null,
          entityType: "privacy_rights_request",
          entityId: row.id,
          action: "created",
          metadata: { kind: "rights_request", source: "public_intake", requestType: body.requestType },
        });
        return { id: row.id, publicReference: row.publicReference! };
      });
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } }).code
        ?? (err as { cause?: { code?: string } }).cause?.code;
      if (code !== "23505" || attempt === 2) throw err;
    }
  }

  void notifyPrivacyAdministrators({
    clientId: form.clientId,
    requestId: created!.id,
    requestType: body.requestType,
    publicReference: created!.publicReference,
    receivedAt,
    dueAt,
    assigneeId,
    businessName: form.organisationName,
  }).catch((err) => req.log?.warn({ err }, "Online privacy request notification failed"));

  res.status(201).json({ reference: created!.publicReference, receivedAt });
});

export default router;
