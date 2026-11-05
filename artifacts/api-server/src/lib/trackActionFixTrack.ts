import { db } from "@workspace/db";
import { fixTrackIssueActivityTable, fixTrackIssuesTable, sitesTable, trackActionsTable } from "@workspace/db/schema";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TrackAction = typeof trackActionsTable.$inferSelect;

/**
 * Raise a FixTrack job for a module action, only ever at a person's choice
 * (the "Send to FixTrack?" question on the action, or on an audit report's
 * actions when they are confirmed). The action stays open in its own track
 * and can be resolved there or in FixTrack; either one completes both.
 */
export async function raiseFixTrackJobForAction(tx: Tx, input: {
  action: TrackAction; clientId: number; userId: number; reportedBy: string;
}): Promise<TrackAction | null> {
  const { action, clientId } = input;
  // A failed temperature keeps its manager verification in KitchenTrack ("parallel").
  const keptInTrack = action.module === "kitchen" && !!action.sourceKind?.startsWith("kitchen_temperature_");
  const [site] = action.siteId ? await tx.select({ name: sitesTable.name }).from(sitesTable).where(and(eq(sitesTable.id, action.siteId), eq(sitesTable.clientId, clientId))).limit(1) : [];
  const [issue] = await tx.insert(fixTrackIssuesTable).values({
    clientId, siteId: action.siteId, title: action.title, issueType: "general",
    location: site?.name ?? "See originating module action",
    description: [action.instruction, `Originating module: ${action.module}`, `Module action: ${action.id}`].filter(Boolean).join("\n"),
    priority: action.severity === "urgent" ? "urgent" : action.severity === "action_required" ? "high" : "medium",
    status: "reported", reportedBy: input.reportedBy, reportedDate: new Date().toISOString().slice(0, 10),
    targetDate: action.dueDate, assignedTo: action.ownerName, assigneeUserId: action.assigneeUserId, createdBy: input.userId,
  }).returning();
  await tx.insert(fixTrackIssueActivityTable).values({ clientId, issueId: issue.id, eventType: "status", status: "reported", createdBy: input.userId });
  const [row] = await tx.update(trackActionsTable).set({ fixTrackIssueId: issue.id, fixTrackDisposition: keptInTrack ? "parallel" : "linked", updatedAt: new Date() })
    .where(and(eq(trackActionsTable.id, action.id), isNull(trackActionsTable.fixTrackIssueId))).returning();
  return row ?? null;
}

/**
 * Signing off an action in its own track also finishes its FixTrack job,
 * so the two stay in step. A job whose contractor email is mid-send, or
 * that is already finished, is left alone.
 */
export async function resolveLinkedFixTrackJob(tx: Tx, input: {
  clientId: number; issueId: number; userId: number; action: TrackAction;
}) {
  const { action } = input;
  const [job] = await tx.update(fixTrackIssuesTable).set({
    status: "resolved",
    resolvedDate: sql`(now() AT TIME ZONE 'Europe/London')::date` as any,
    resolvedByName: action.resolvedByName,
    resolverSignature: action.resolverSignature,
    solutionNotes: sql`coalesce(nullif(trim(${fixTrackIssuesTable.solutionNotes}), ''), ${`Completed in the originating track: ${action.resolutionNotes ?? action.remedialAction ?? ""}`.trim()})` as any,
    updatedAt: new Date(),
  }).where(and(
    eq(fixTrackIssuesTable.id, input.issueId), eq(fixTrackIssuesTable.clientId, input.clientId),
    inArray(fixTrackIssuesTable.status, ["reported", "in_progress"]),
    or(isNull(fixTrackIssuesTable.emailRequestStatus), ne(fixTrackIssuesTable.emailRequestStatus, "sending")),
  )).returning({ id: fixTrackIssuesTable.id });
  if (job) await tx.insert(fixTrackIssueActivityTable).values({
    clientId: input.clientId, issueId: job.id, eventType: "status", status: "resolved", createdBy: input.userId,
  });
  return !!job;
}
