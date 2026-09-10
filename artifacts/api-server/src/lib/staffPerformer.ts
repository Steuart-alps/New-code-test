import { db } from "@workspace/db";
import { staffMembersTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

/** Validate a roster member in the active tenant and return its server name. */
export async function resolveStaffPerformer(
  clientId: number | null,
  staffRosterId: number | null | undefined,
  fallback: string | null | undefined = null,
) {
  if (clientId == null) return null;
  if (staffRosterId == null) return { staffRosterId: null, performedBy: fallback ?? null };
  const [member] = await db.select({ id: staffMembersTable.id, name: staffMembersTable.name })
    .from(staffMembersTable)
    .where(and(eq(staffMembersTable.id, staffRosterId), eq(staffMembersTable.clientId, clientId), eq(staffMembersTable.active, true)))
    .limit(1);
  if (!member) return null;
  return { staffRosterId: member.id, performedBy: member.name };
}

/** Update invariant: omission preserves the stored immutable snapshot; a
 * supplied id must be active and tenant-owned, while null intentionally clears. */
export async function resolveStaffPerformerUpdate(
  clientId: number | null,
  requestedId: number | null | undefined,
  requestedName: string | null | undefined,
  existingId: number | null | undefined,
  existingName: string | null | undefined,
) {
  const nameWasExplicitlyChanged = requestedName !== undefined &&
    requestedName !== existingName;
  if (requestedId === undefined && !nameWasExplicitlyChanged) {
    return { staffRosterId: existingId ?? null, performedBy: existingName ?? null };
  }
  // A null/undefined id with a non-empty explicitly supplied name is a
  // deliberate free-text performer, not an instruction to retain the roster.
  if ((requestedId === null || requestedId === undefined) &&
      requestedName != null && requestedName.trim() !== "") {
    return { staffRosterId: null, performedBy: requestedName.trim() };
  }
  if (requestedId === null ||
      (requestedId === undefined && (requestedName === null ||
        (requestedName !== undefined && requestedName.trim() === "")))) {
    return { staffRosterId: null, performedBy: null };
  }
  if (requestedId === existingId && existingName != null) {
    return { staffRosterId: existingId, performedBy: existingName };
  }
  return resolveStaffPerformer(clientId, requestedId, requestedName);
}
