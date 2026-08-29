# Research Notes: UK compliance comparison across ComplyTrack

**Status:** complete — qualified UK specialist approval still required before release
**Depth:** Standard

## Plan

- **Question:** What current UK legal duties, official guidance, ACOPs, industry guidance and best practice should each ComplyTrack track signpost without implying certification?
- **Scope:** All operational, people, premises, equipment, water, food, incident and records tracks; England, Wales, Scotland and Northern Ireland where differences matter.
- **Audience:** ComplyTrack product owners and qualified UK reviewers.
- **Deliverable:** Source register with classification, jurisdiction, applicability, review date, implementation gaps and safe wording.

## Focus Areas

| # | Area | Status | Sources |
|---|---|---|---|
| 1 | General duties, fire and premises | complete | HSWA, Management Regulations, GOV.UK, gov.scot, HSE |
| 2 | Food, kitchen, pest and cleaning | complete | FSA, Food Standards Scotland, DAERA |
| 3 | Water, pools, spas and Legionella | complete | HSE L8, HSG274, HSG179, HSG282, PWTAG |
| 4 | Equipment, PAT, trees, bikes and grounds | complete | HSE, Electricity at Work Regulations, PUWER, BSI signpost |
| 5 | People, incidents, documents, training and privacy | complete | HSE RIDDOR, L74, competence/training, ICO |

## Coverage Checklist

- [x] Every requested track has at least one appropriate source and classification.
- [x] Legal duties are separated from ACOP, official guidance, industry guidance and best practice.
- [x] England, Wales, Scotland and Northern Ireland differences are visible where material.
- [x] Risk assessment, competent person, accountability, evidence, corrective action and emergency controls are addressed.
- [x] Fixed intervals and numeric thresholds are qualified unless genuinely statutory or source-specific.
- [x] The product disclaimer avoids claims of certification or blanket compliance.
- [x] Gaps are prioritised for implementation and prepared for qualified specialist approval.

## Findings Log

- The register now contains 31 source entries covering all 19 requested track groupings plus the all-track legal baseline.
- Each source records classification, jurisdiction, applicability, accountable owner, URL, review date and a safe implementation note.
- Fire and incident law needs nation-aware routing; Great Britain guidance must not be presented as directly applying in Northern Ireland.
- Food records must connect to the business's HACCP/CookSafe/SFBB system, critical limits, corrective action and verification.
- Water, pool and spa controls require a site-specific risk assessment, written scheme or operating plan, competent reviewer and local limits.
- PAT, work-equipment, tree and grounds intervals are risk-based unless a particular assessment, manufacturer or competent person specifies otherwise.
- Document acknowledgement is not competence; employment, health and incident records need role-based access and a client-specific retention schedule.
- DailyTrack and RoomTrack are operational evidence systems. Their cadence and pass criteria are local standards, not universal statutory categories.

## Conflicts & Open Questions

- Fire duties differ across England/Wales, Scotland and Northern Ireland; one generic legal label would be misleading.
- FSA material is not always the right operational pack for Scotland or Northern Ireland; the applicable national regulator must be visible.
- Industry and British Standard material can be valuable but is not legislation. Paid standard text must not be reproduced.
- External source pages can move. All register URLs were checked on 2026-08-29 and the moved FSA, gov.scot and HSE references were corrected.

## Gaps

Eight actionable comparison gaps are exposed by the Compliance Hub API and UI, prioritised as high, medium or low:

1. Nation-specific fire and incident workflows.
2. Site-level accountability and applicability review.
3. Operation-specific food controls.
4. Water written-scheme and competent-person confirmation.
5. Risk-based equipment rationale and quarantine/retest trails.
6. Contractor competence and coordination evidence.
7. Privacy, retention and access controls for people records.
8. Explicit local standards for DailyTrack and RoomTrack.

## Evidence

Fetched and discovery evidence is stored in `research/sources/`. The register is a structured comparison for product governance; it is not a legal opinion and requires the already-planned qualified UK specialist review.
