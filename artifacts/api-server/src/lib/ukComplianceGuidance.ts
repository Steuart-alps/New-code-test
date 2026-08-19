export type GuidanceClassification = "Legislation" | "Approved Code of Practice" | "Official guidance" | "Industry guidance" | "British Standard / best practice";

export interface ComplianceGuidance {
  track: string;
  title: string;
  classification: GuidanceClassification;
  applicability: string;
  url: string;
  reviewNote: string;
}

/**
 * Public, authoritative signposts only. Standards are referenced by title and
 * never reproduced because their text is licensed and risk controls must be
 * selected for the particular premises.
 */
export const UK_COMPLIANCE_GUIDANCE: ComplianceGuidance[] = [
  { track: "All tracks", title: "Health and Safety at Work etc. Act 1974", classification: "Legislation", applicability: "Employers and duty holders across Great Britain; Northern Ireland has its own framework.", url: "https://www.legislation.gov.uk/ukpga/1974/37/contents", reviewNote: "Apply with the legislation and regulator guidance for the nation and activity." },
  { track: "FireTrack", title: "Fire safety in the workplace", classification: "Official guidance", applicability: "Responsible persons; fire law differs across England/Wales, Scotland and Northern Ireland.", url: "https://www.gov.uk/workplace-fire-safety-your-responsibilities", reviewNote: "Use a suitable fire risk assessment and competent advice; checks are risk-assessed, not universal legal intervals." },
  { track: "KitchenTrack", title: "Safer food, better business", classification: "Official guidance", applicability: "Food businesses in England and Wales; use the nation-specific food safety authority material where applicable.", url: "https://www.food.gov.uk/business-guidance/safer-food-better-business-sfbb", reviewNote: "Document a HACCP-based system specific to the food operation and its critical limits." },
  { track: "LegionellaTrack", title: "Legionnaires' disease: L8", classification: "Approved Code of Practice", applicability: "Duty holders managing water systems in Great Britain.", url: "https://www.hse.gov.uk/pubns/books/l8.htm", reviewNote: "The written scheme, monitoring frequencies and controls follow the site risk assessment and competent-person advice." },
  { track: "AquaTrack", title: "Health and safety in swimming pools (HSG179)", classification: "Official guidance", applicability: "Pool operators and duty holders.", url: "https://www.hse.gov.uk/pubns/books/hsg179.htm", reviewNote: "Pool operating procedures and test ranges must be specific to the installation and bather risks." },
  { track: "AquaTrack", title: "PWTAG pool water treatment guidance", classification: "Industry guidance", applicability: "Pool water operators.", url: "https://www.pwtag.org/", reviewNote: "Use alongside competent water-treatment advice and local procedures." },
  { track: "TubTrack", title: "Management of spa pools (HSG282)", classification: "Official guidance", applicability: "Spa-pool duty holders.", url: "https://www.hse.gov.uk/pubns/books/hsg282.htm", reviewNote: "Set monitoring and remedial controls from a site-specific risk assessment and written scheme." },
  { track: "PATtrack", title: "Maintaining portable and transportable electrical equipment", classification: "Official guidance", applicability: "Duty holders responsible for electrical equipment.", url: "https://www.hse.gov.uk/pubns/indg236.htm", reviewNote: "PAT is one way to support electrical safety; inspection and testing intervals are risk-based, not automatically annual." },
  { track: "IncidentTrack", title: "RIDDOR: reporting incidents", classification: "Official guidance", applicability: "Responsible persons in Great Britain.", url: "https://www.hse.gov.uk/riddor/", reviewNote: "Record the reportability decision, investigation, report reference and evidence; report within statutory timescales where required." },
  { track: "PremisesTrack", title: "Workplace health, safety and welfare", classification: "Official guidance", applicability: "Workplace duty holders in Great Britain.", url: "https://www.hse.gov.uk/workplacetransport/", reviewNote: "Risk assessments and actions must be proportionate to the workplace and activities." },
  { track: "TreeTrack", title: "Managing risks from trees", classification: "Official guidance", applicability: "Landowners and managers responsible for trees where people or property may be affected.", url: "https://www.hse.gov.uk/foi/internalops/sims/ag_food/010705.htm", reviewNote: "Inspection frequency and arboricultural works are risk-based; BS 3998 is a licensed best-practice standard, not a universal annual legal rule." },
  { track: "PestTrack", title: "Food hygiene: keeping food safe", classification: "Official guidance", applicability: "Food businesses and premises where pests could affect hygiene.", url: "https://www.food.gov.uk/business-guidance/food-hygiene", reviewNote: "Set monitoring, proofing and treatment controls around the premises risk assessment and HACCP system." },
  { track: "BikeTrack", title: "Work equipment and machinery", classification: "Official guidance", applicability: "Where bikes or related equipment are supplied for work.", url: "https://www.hse.gov.uk/work-equipment-machinery/puwer.htm", reviewNote: "Use checks, maintenance and competence controls proportionate to how equipment is used." },
  { track: "FixTrack / DailyTrack", title: "Managing risks and risk assessment at work", classification: "Official guidance", applicability: "Employers and self-employed duty holders in Great Britain.", url: "https://www.hse.gov.uk/simple-health-safety/risk/", reviewNote: "Log interim controls, ownership, evidence and verification for any safety-related finding." },
  { track: "DocTrack / TrainTrack", title: "Health and safety training", classification: "Official guidance", applicability: "Employers who need staff to be competent for their work.", url: "https://www.hse.gov.uk/training/", reviewNote: "Records evidence training and acknowledgement; assess competence and refresher needs for the actual role and risks." },
  { track: "GreenTrack", title: "Health and safety in landscaping and horticulture", classification: "Official guidance", applicability: "Grounds, horticulture and maintenance work.", url: "https://www.hse.gov.uk/agriculture/topics/landscaping.htm", reviewNote: "Use activity-specific risk assessments, competent contractors and evidence of controls." },
];