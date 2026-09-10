import { and, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { trackEvidenceRequirementsTable, trackEvidenceTable } from "@workspace/db/schema";

type ProfileRequirement = {
  requirementKey: string;
  title: string;
  description: string;
  evidenceType: string;
  minimumCount: number;
  reviewRequired: boolean;
};

export const DEFAULT_TRACK_EVIDENCE_REQUIREMENTS: Record<string, ProfileRequirement[]> = {
  fire: [
    { requirementKey: "risk_assessment", title: "Current fire risk assessment", description: "Current version, assessment date and next review date.", evidenceType: "document", minimumCount: 1, reviewRequired: true },
    { requirementKey: "responsible_person", title: "Responsible person and role", description: "Named responsible person and their operational role.", evidenceType: "observation", minimumCount: 1, reviewRequired: false },
    { requirementKey: "evacuation_plan", title: "Evacuation plan and PEEP evidence", description: "Evacuation arrangements, including relevant personal emergency evacuation plans.", evidenceType: "document", minimumCount: 1, reviewRequired: true },
    { requirementKey: "maintenance_certificate", title: "Fire maintenance certificate", description: "Relevant alarm, emergency-lighting, extinguisher or door maintenance certificate.", evidenceType: "certificate", minimumCount: 1, reviewRequired: true },
    { requirementKey: "defect_verification", title: "Defect closure verification", description: "Evidence that a fire defect was corrected and independently checked.", evidenceType: "verification", minimumCount: 1, reviewRequired: true },
  ],
  legionella: [
    { requirementKey: "water_system_inventory", title: "Water-system inventory", description: "The site water-system assets, outlets and relevant plant are recorded.", evidenceType: "document", minimumCount: 1, reviewRequired: true },
    { requirementKey: "written_control_scheme", title: "Written control scheme", description: "Current control scheme version, owner and review date.", evidenceType: "document", minimumCount: 1, reviewRequired: true },
    { requirementKey: "risk_assessment", title: "Legionella risk assessment", description: "Current assessment version, assessor and next review date.", evidenceType: "document", minimumCount: 1, reviewRequired: true },
    { requirementKey: "competent_person", title: "Responsible and competent person", description: "Named duty holder and competent person details.", evidenceType: "observation", minimumCount: 1, reviewRequired: false },
    { requirementKey: "sampling_lab_record", title: "Sampling and laboratory record", description: "Sample locations, dates, laboratory and result references.", evidenceType: "test_result", minimumCount: 1, reviewRequired: true },
    { requirementKey: "control_limits", title: "Control limits and rationale", description: "Temperature or other control limits with the reason for the chosen limits.", evidenceType: "observation", minimumCount: 1, reviewRequired: false },
    { requirementKey: "remedial_verification", title: "Remedial-action verification", description: "Evidence that an out-of-limit result was corrected and rechecked.", evidenceType: "verification", minimumCount: 1, reviewRequired: true },
    { requirementKey: "scheme_review", title: "Scheme applicability review", description: "Confirmation that the scheme and HSG274 scope remain applicable to the site.", evidenceType: "document", minimumCount: 1, reviewRequired: true },
  ],
};

export async function ensureDefaultTrackEvidenceRequirements(clientId: number, module: string) {
  const defaults = DEFAULT_TRACK_EVIDENCE_REQUIREMENTS[module] ?? [];
  if (!defaults.length) return [];
  const existing = await db.select().from(trackEvidenceRequirementsTable).where(and(
    eq(trackEvidenceRequirementsTable.clientId, clientId),
    eq(trackEvidenceRequirementsTable.module, module),
    eq(trackEvidenceRequirementsTable.active, true),
  ));
  const existingKeys = new Set(existing.map(row => row.requirementKey));
  const missing = defaults.filter(item => !existingKeys.has(item.requirementKey));
  if (missing.length) {
    await db.insert(trackEvidenceRequirementsTable).values(missing.map(item => ({
      clientId,
      module,
      siteId: null,
      ...item,
    }))).onConflictDoNothing();
  }
  return db.select().from(trackEvidenceRequirementsTable).where(and(
    eq(trackEvidenceRequirementsTable.clientId, clientId),
    eq(trackEvidenceRequirementsTable.module, module),
    eq(trackEvidenceRequirementsTable.active, true),
  ));
}

export async function missingEvidenceForAction(clientId: number, action: {
  id: number;
  module: string;
  sourceKind: string | null;
}) {
  // Manual actions retain the existing resolution contract. Product-generated
  // FireTrack/LegionellaTrack actions use the structured profile.
  if (!action.sourceKind || !DEFAULT_TRACK_EVIDENCE_REQUIREMENTS[action.module]) return [];
  const requirements = await ensureDefaultTrackEvidenceRequirements(clientId, action.module);
  if (!requirements.length) return [];
  const keys = requirements.map(item => item.requirementKey);
  const evidence = await db.select({
    requirementKey: trackEvidenceTable.requirementKey,
    evidenceType: trackEvidenceTable.evidenceType,
    reviewStatus: trackEvidenceTable.reviewStatus,
  }).from(trackEvidenceTable).where(and(
    eq(trackEvidenceTable.clientId, clientId),
    eq(trackEvidenceTable.module, action.module),
    eq(trackEvidenceTable.actionId, action.id),
    inArray(trackEvidenceTable.requirementKey, keys),
  ));
  return requirements.filter(requirement => {
    const matching = evidence.filter(item =>
      item.requirementKey === requirement.requirementKey && item.evidenceType === requirement.evidenceType,
    );
    const usable = requirement.reviewRequired
      ? matching.filter(item => item.reviewStatus === "verified")
      : matching;
    return usable.length < requirement.minimumCount;
  });
}