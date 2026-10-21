/**
 * The person responsible for a track action, FixTrack issue or compliance
 * check: a user of the business, so their reminders reach them
 * (lib/personalReminders.ts). Who may be assigned is who may own a track
 * (lib/trackOwners.ts): active Owners, Managers, staff and the business's
 * consultants, never read-only viewers, and only someone who can see the
 * record's site.
 *
 * Each record keeps its text name (owner_name / assigned_to): screens show it,
 * and it can hold a typed name for someone without an account. Picking a
 * person sets both; typing a different name clears the person.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { candidateCanSeeSite, loadEligibleOwners, type OwnerCandidate } from "./trackOwners";

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

async function siteDepartmentId(clientId: number, siteId: number): Promise<number | null | undefined> {
  const [site] = rowsOf<{ department_id: number | null }>(await db.execute(sql`
    SELECT department_id FROM sites WHERE id = ${siteId} AND client_id = ${clientId}
  `));
  if (!site) return undefined;
  return site.department_id == null ? null : Number(site.department_id);
}

/** People who can be assigned work at a site (null = business-wide). */
export async function listAssignees(clientId: number, siteId: number | null): Promise<OwnerCandidate[]> {
  const candidates = await loadEligibleOwners(clientId);
  if (siteId == null) return candidates;
  const departmentId = await siteDepartmentId(clientId, siteId);
  if (departmentId === undefined) return [];
  return candidates.filter((candidate) => candidateCanSeeSite(candidate, departmentId, siteId));
}

export interface AssigneeInput {
  /** The person picked; undefined when the request does not change it. */
  assigneeUserId?: number | null;
  /** The typed name; undefined when the request does not change it. */
  name?: string | null;
}

export interface CurrentAssignee {
  assigneeUserId: number | null;
  name: string | null;
  siteId: number | null;
}

/** The columns to write, or why the choice is refused. */
export type AssigneeChange =
  | { ok: true; assigneeUserId?: number | null; name?: string | null }
  | { ok: false; error: string };

/**
 * Validate an assignment for a record at `siteId` (its site after the change)
 * and work out what to store. With `current`, a site move re-checks the
 * existing person, and typing over a picked person's name unlinks them.
 */
export async function resolveAssigneeChange(
  clientId: number,
  siteId: number | null,
  input: AssigneeInput,
  current: CurrentAssignee | null = null,
): Promise<AssigneeChange> {
  const check = async (userId: number): Promise<{ candidate: OwnerCandidate } | { error: string }> => {
    const candidate = (await loadEligibleOwners(clientId)).find((user) => user.id === userId);
    if (!candidate) return { error: "Choose an active member of this business to assign" };
    if (siteId != null) {
      const departmentId = await siteDepartmentId(clientId, siteId);
      if (departmentId === undefined) return { error: "That site isn't part of this business" };
      if (!candidateCanSeeSite(candidate, departmentId, siteId)) {
        return { error: `${candidate.name} can't access that site's department` };
      }
    }
    return { candidate };
  };

  if (input.assigneeUserId != null) {
    const result = await check(input.assigneeUserId);
    if ("error" in result) return { ok: false, error: result.error };
    return { ok: true, assigneeUserId: result.candidate.id, name: result.candidate.name };
  }
  if (input.assigneeUserId === null) {
    // Clearing the person also clears their name, unless a typed name replaces it.
    const name = input.name !== undefined
      ? input.name
      : current?.assigneeUserId != null ? null : undefined;
    return { ok: true, assigneeUserId: null, ...(name !== undefined ? { name } : {}) };
  }

  const changes: { assigneeUserId?: number | null; name?: string | null } = {};
  if (input.name !== undefined) {
    changes.name = input.name;
    const typed = input.name?.trim() ?? "";
    if (current?.assigneeUserId != null && typed !== (current.name ?? "").trim()) changes.assigneeUserId = null;
  }
  // Moving a record to a site its person can't see is refused rather than
  // silently unassigning them.
  // A person who has since left the business doesn't block the move; their
  // reminders already fall back to the track owner.
  if (current?.assigneeUserId != null && changes.assigneeUserId === undefined && siteId !== current.siteId && siteId != null) {
    const person = (await loadEligibleOwners(clientId)).find((user) => user.id === current.assigneeUserId);
    const departmentId = await siteDepartmentId(clientId, siteId);
    if (person && departmentId !== undefined && !candidateCanSeeSite(person, departmentId, siteId)) {
      return { ok: false, error: `${person.name} can't access the new site's department. Choose someone else.` };
    }
  }
  return { ok: true, ...changes };
}
