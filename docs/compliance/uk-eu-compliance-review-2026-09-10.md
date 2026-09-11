# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
# ComplyTrack UK / Europe Compliance and Audit-Readiness Review

**Review date:** 10 September 2026  
**Scope:** Web application, API, database model, mobile surface, evidence workflows, access controls, exports, and in-product compliance guidance.  
**Purpose:** Product gap assessment against official UK sources, EU data-protection requirements, and operational best practice.  

> This is not legal advice, certification, or a competent-person assessment. ComplyTrack can help a business organise evidence and reminders; it cannot determine that a site is legally compliant. Legal duties depend on the country, UK nation, premises, activity, risk assessment, competent advice, and the organisation's own arrangements.

## Executive conclusion

**Overall status: NOT READY to claim “UK/EU legally compliant” or “inspection-ready” across all tracks.**

The product has a useful operational foundation:

- tenant and department isolation is implemented in many routes;
- mandatory TOTP, session controls, role guards, object ACLs, and selected isolation tests exist;
- the guidance layer distinguishes legislation, ACOP, official guidance, industry guidance, and best practice;
- FixTrack, RIDDOR history, selected fire/incident routes, DocTrack acknowledgements, exports, and reminder jobs provide a basis for defensible workflows;
- the product correctly warns that generic records do not certify compliance.

The blockers are not primarily missing checkboxes. They are evidence integrity, privacy accountability, legal applicability, and incomplete track-specific controls:

1. Most track records can be edited or deleted without a complete immutable revision history.
2. Audit events are selective rather than global and are not independently tamper-evident.
3. Public sign-off links do not establish strong signer identity, expiry, version binding, or a reliable audit trail.
4. Retention, legal holds, deletion verification, DSARs, breach response, processor governance, and international-transfer controls are not productised.
5. Important statutory and sector records are simplified into pass/fail or due/overdue statuses without the risk assessment, competent-person, version, calibration, verification, or escalation context that makes them meaningful.
6. Several modules are ambiguous, partially stubbed, raw-SQL/schema-drift risks, or materially absent from mobile.
7. A “full export” is not yet a signed, complete evidential snapshot.

## Rating scale

- **Pass:** Evidence of a meaningful control exists and is reasonably testable, subject to site/legal configuration.
- **Partial:** Useful capability exists, but material evidence, scope, integrity, or applicability gaps remain.
- **Gap:** The product does not currently provide the control needed for the stated audit purpose.
- **Not applicable by default:** The product must establish whether the duty applies rather than presenting a universal rule.

## Legal baseline used for this review

### UK

- HSE risk assessment guidance expects hazards, people at risk, existing and further controls, responsible persons, dates, recording significant findings where applicable, and review of controls.
- UK fire duties vary by UK nation and premises type. A fire logbook is not a fire risk assessment, evacuation plan, maintenance certificate, or proof that the responsible person has discharged the Fire Safety Order or its national equivalent.
- Food businesses need a food safety management system based on hazard analysis principles. A temperature diary alone is not HACCP or a complete food-safety management system.
- Legionella controls need a site-specific risk assessment, competent-person arrangements, a written control scheme, records, monitoring, remedial actions, and review. HSG274/L8 recommendations are not universal calendar rules.
- RIDDOR is a statutory reporting regime with reportability categories and deadlines. The software must support a decision and evidence trail; it must not silently decide that an incident is or is not reportable.
- PAT records support electrical-equipment management but do not equal compliance with the Electricity at Work Regulations. Frequency and testing depend on risk and competent assessment.
- Contractor appointment does not transfer the employer or premises duty. Competence, coordination, supervision, RAMS/permits, insurance, and close-out evidence still matter.

### EU / EEA

- GDPR applies to personal-data processing and requires lawful, fair, transparent, purpose-limited, minimised, accurate, storage-limited, secure, and accountable processing. Employee, incident, injury, occupational-health, and some training information can create special-category or high-risk processing.
- UK GDPR and EU GDPR are similar but not interchangeable. Controller/processor roles, representative requirements, supervisory authority, transfer mechanism, local employment law, and retention rules must be set for the actual customer and processing location.
- Workplace safety, fire, food, water, and electrical duties are not one single pan-European checklist. Member-State and sector rules need local applicability profiles rather than an “EU compliant” switch.
- NIS2 is not automatically applicable to every SaaS customer or to ComplyTrack. Applicability depends on the entity, sector, size, and national implementation. Its security controls are useful best practice, but the product must not market NIS2 compliance without an applicability assessment.

## Track-by-track assessment

| Track / surface | Status | What exists | Main legal or audit gap |
|---|---|---|---|
| DailyTrack / daily checklists | Partial | AM/PM submissions, history, missing/due status, PM manager sign-off | JSON rows and corrections need immutable revisions, correction reason, site applicability, verification, and a consistent evidence package |
| KitchenTrack / Food Safety | Partial / High risk | Deliveries, cold/hot/cooling/reheating/hot-holding/sous-vide records, configured limits, performer, missing-date view, cleaning logs | No complete operation-specific HACCP, allergen, traceability/withdrawal, probe calibration, illness/training, verification, or strong manager closure model; Kitchen and Food Safety surfaces are ambiguous |
| FireTrack | Partial / High risk | Check types, dates, pass/fail, notes/photos/performer, due/overdue summary, some remediation linkage | No linked fire risk assessment/version, responsible person, nation-specific applicability, PEEPs/evacuation evidence, maintenance certificate, defect verification, or protected history |
| LegionellaTrack | Partial / High risk | Outlet/check records, temperatures/notes, due/overdue logic, action creation | No written scheme, system inventory/hierarchy, risk assessment/reviewer, competent water specialist, lab/sampling record, control limits, remedial verification, or scheme version |
| FixTrack | Partial / strongest action workflow | Issue status, target/resolved dates, assignee/contractor, notes/media, resolver signature, activity history, contractor approval flow | Closure needs signer identity/authentication, immutable signed version, independent verification, risk/hazard/persons-exposed fields, interim controls, root cause, effectiveness, and links back to source track |
| DocTrack / SafeTrack | Partial / ambiguous | Controlled documents, versions, acknowledgement, signatures, reminders, export; SafeTrack tables and legacy APIs remain | SafeTrack route redirects to DocTrack; receipt is not understanding or competence; document ownership, approval, effective date, supersession, withdrawal, legal hold, and revision history need strengthening |
| TrainTrack / staff training | Partial | Course, completion/expiry, notes/signature, reminders, training matrix | Attendance is not competence; missing role/risk matrix, assessment, supervision, accessibility/language evidence, refresher rationale, and privacy/retention controls |
| HotTubTrack | Partial | Water chemistry, temperature, filter/cover/drain/microbiological/risk checks, performer, due/overdue | No unified risk-assessment/written-scheme evidence, sampling/lab chain, verified corrective action, or jurisdiction/site applicability |
| AquaTrack / PoolTrack / SwimTrack | Gap / schema risk | Pool measurements and swim/incident flows exist; legacy namespaces redirect to AquaTrack | Routes use raw SQL and exported Drizzle schema does not clearly contain corresponding tables; no unified sign-off/closure or complete pool safety evidence model |
| TreeTrack | Partial | Inspections, result, follow-up date, notes, attribution, due status | No risk basis, competent arborist evidence, work-control linkage, closure verification, or immutable revision history |
| BikeTrack | Partial | Asset identity, hire/return checks, defects, servicing, overdue/maintenance status, exports | No consistent competent inspection sign-off, defect quarantine/retest chain, or immutable evidence package |
| GreenTrack / equipment and PUWER | Gap / visibly incomplete | API surface for machines, pre-use checks, services, defects, PUWER, fuel, status; reconciliation identity work | Web UI says records are coming; core Green tables are not clearly in exported schema; no consistent asset/check/defect/PUWER evidence, operator competence, isolation, service, or close-out trail |
| IncidentTrack / RIDDOR | Partial / strongest statutory history | Incident severity/status, investigation fields, people/witnesses, corrective actions, RIDDOR decision/submission event history | Needs statutory clock/deadline workflow, responsible reporter, nation/regulator path, explicit reportability decision checklist, evidence attachment, investigation/root cause, lessons, and effectiveness review |
| PATTrack | Partial | Appliance identity/location/tag, tests, measurements, tester, due dates, failures, replacements, exports | No risk-based test rationale, competent authorisation, calibration evidence, isolation/quarantine/retest history, fixed-installation distinction, or complete defect close-out |
| PestTrack | Partial | Visits, provider, next visit, activity, severity, actions, notes, flags | Needs site risk/food-safety linkage, treatment evidence, verification, chemical controls, and protected history |
| PremisesTrack | Partial | Inspection dates, areas/findings/actions/notes, open/closed status | No standard/risk basis, welfare/occupancy context, competent inspection evidence, or closure verification |
| RoomTrack | Partial | Room inventory, daily checks, staff, flags, status, notes, one check per room/day | No location/site applicability model strong enough for all cases, verification, or protected corrections |
| Compliance Hub / generic actions | Partial | Actions with owner, due date, priority, department/site/category/contractor, status, reminders | Completion is status only; no universal evidence, verification, signature, source-record link, risk score, or immutable closure |
| Contractors / certificates / external checks | Partial / high privacy risk | Certificates, expiry reminders, contractor portal, insurance/Gas Safe/DBS/PVG fields, approvals | Competence scope, policy limits, RAMS/permits, induction, supervision, subcontractors, attendance, close-out, privacy notice, retention, and link-token controls are incomplete |
| Mobile surface | Partial | Daily, cleaning, kitchen, Aqua, incident, PAT, SafeTrack/docs, and FixTrack issue reporting | Most web tracks are absent on mobile; mobile bearer-token lifecycle and feature parity need separate audit; physical-device testing remains deferred |

## Cross-cutting control assessment

### 1. Evidence integrity and audit trail — **Gap / highest priority**

Strengths:

- There is an audit-event model with actor, tenant, before/after, metadata, and server timestamp.
- Database protection prevents updates/deletes to audit rows.
- RIDDOR history has stronger immutable treatment.
- FixTrack requires resolution details and a resolver signature.

Gaps:

- Audit writes are selective. Food Safety, documents, sites, departments, contractors, PAT, Pest, Bike, Legionella, Tree, and many other mutations are not globally covered.
- Most records are mutable in place or deletable. `updated_at` is not a revision history.
- Audit events are not hash-chained, externally sealed, signed, or exported as part of a chain-of-custody package.
- Manager/admin backfills can bypass the daily cutoff without a mandatory reason, original entered-at value, or second approval.
- Signatures are not consistently bound to signer identity, authentication event, content/version hash, timestamp, source, or a non-repudiation level.
- A public typed-name sign-off is not equivalent to an authenticated approval.

**Required baseline:** append-only record revisions or event sourcing for every regulated record; immutable closure snapshots; correction reason and original value; authenticated signer identity; independent verification for high-risk closure; audit export with hashes and manifest.

### 2. Access control and tenant isolation — **Partial**

Strengths:

- Session auth, mandatory TOTP, roles, consultant membership, tenant predicates, department scoping, object ACLs, and regression tests exist.
- Private storage download handling and upload finalisation include useful tenant checks.

Gaps requiring urgent remediation:

- CORS origin validation uses prefix matching rather than exact parsed-origin comparison.
- Generic document registration accepts an object path without proving tenant ownership or upload existence, and its download path does not apply the same ACL chain as storage routes.
- Site updates accept arbitrary department IDs without confirming same-client ownership.
- Public sign-off and contractor/public FixTrack links are bearer credentials with weak identity assurance, limited access logging, and incomplete rate limiting/revocation.
- Mobile bearer tokens are stored/compared differently from hashed contractor tokens and lack a visible device/session management lifecycle.
- Cookie-authenticated mutations do not show a complete CSRF defence.
- Client staff mutation rights are not represented by a single tested endpoint matrix.
- Shared demo credentials must never be reachable in a real tenant or production-like environment.

### 3. Privacy, GDPR, and PECR accountability — **Gap**

The product handles names, email addresses, contractor contact details, certificates, training, incident/injury narratives, witnesses, occupational disease fields, possible health information, authentication data, and uploaded documents.

Missing or not evident:

- privacy notice and layered collection notices;
- controller/processor role allocation and customer instructions;
- Records of Processing Activities;
- lawful basis and Article 9 condition assessment where health data is processed;
- DPIA/high-risk processing assessment;
- DSAR, rectification, restriction, objection, portability, and erasure workflow;
- identity verification and request deadline tracking;
- processor/subprocessor register and Article 28 contract controls;
- international transfer assessment and mechanism;
- PECR marketing consent/unsubscribe controls;
- field-level minimisation and special-category access restrictions;
- retention schedule by record type and documented legal exceptions.

The existing tenant export is useful for administration but is not a verified data-subject response and is not guaranteed complete. Free-text exports can over-disclose personal or health information.

### 4. Retention, deletion, and legal hold — **Gap**

The offboarding job has a useful cancellation warning/export concept, but it uses a broad 12-month rule and best-effort deletion. It does not visibly prove:

- object-storage deletion;
- email-queue deletion;
- provider-side deletion or retention;
- session, token, portal-link, and audit retention;
- legal hold or regulator/claim preservation;
- category-specific statutory retention;
- deletion verification and exception report;
- preservation of a complete signed audit package before deletion.

Hard-delete client operations are not an adequate substitute for a data-subject rights process and can conflict with inspection, RIDDOR, contractual, or litigation preservation duties.

### 5. Export and inspection package — **Partial**

Exports include many operational tables and attachment manifests with useful ACL/cap checks. They do not yet provide:

- export requester and authorisation event;
- data cut-off and query scope;
- schema/version manifest;
- audit-event inclusion;
- cryptographic hashes for records and attachments;
- complete attachment inclusion or a controlled exception report;
- signed chain-of-custody package;
- legal hold marker;
- verified data-subject redaction workflow.

### 6. Security incident and resilience governance — **Gap**

Logging, Sentry integration, readiness checks, session controls, and webhook verification are positive. A launch-ready UK/EU SaaS still needs a documented and tested:

- incident register and severity classification;
- containment, evidence preservation, and recovery process;
- controller/processor breach decision and 72-hour timer;
- customer notification workflow;
- vulnerability and patch management;
- privileged-access review;
- key rotation and secrets lifecycle;
- backup/restore evidence;
- disaster recovery and business continuity test;
- supplier/subprocessor risk review;
- security training and tabletop exercise.

## Minimum defensible free-launch baseline

If the product is launched without a paid certification programme, the following should be treated as the minimum honest product boundary:

### Must fix before marketing “audit-ready”

1. **Close the document/object-path access path** and test cross-tenant object registration/download.
2. **Replace origin prefix matching with exact origin validation.**
3. **Add CSRF protection or an equivalent robust mutation defence** for cookie-authenticated routes.
4. **Expire, revoke, rate-limit, and log every public sign-off and contractor/action link.**
5. **Create an append-only revision/audit layer for all regulated track records**, not only selected routes.
6. **Bind closure to an authenticated user, version/content hash, server timestamp, reason, and independent verification where risk warrants.**
7. **Create a real retention/hold/deletion policy** with a pre-deletion export package, verification, exception reporting, and category-specific rules.
8. **Add privacy/accountability workflows:** privacy notice, RoPA fields, DSAR case tracking, breach register, processor/subprocessor register, transfer record, and Article 9/DPIA flags.
9. **Resolve schema/route drift for Aqua and GreenTrack** and remove visibly stubbed compliance functionality from any module sold as available.
10. **Make marketing and guidance explicit:** “records and reminders to support your compliance arrangements,” never “legally compliant,” “HSE approved,” “HACCP certified,” or equivalent.

### Track-specific launch boundaries

- **Fire:** only market as a logbook/check reminder until fire-risk-assessment linkage, responsible-person data, national applicability, evacuation/PEEP, maintenance evidence, and verified defect closure exist.
- **Kitchen:** only market as record capture until the customer can maintain an operation-specific HACCP system, allergen controls, traceability/withdrawal, calibration, illness/training, and verification evidence.
- **Legionella:** only market as monitoring support until a site-specific written scheme, competent-person and risk-assessment metadata, sampling/lab records, and remedial verification exist.
- **RIDDOR:** provide decision support and evidence storage; never auto-certify reportability. Add deadlines, responsible reporter, nation, category, submission proof, and investigation follow-up.
- **PAT/Green:** distinguish visual inspection, electrical test, PUWER/equipment checks, servicing, calibration, isolation, repair, retest, operator competence, and risk basis.
- **Doc/Train:** distinguish acknowledgement/attendance from understanding, assessment, and competence. Preserve version, approval, effective date, supersession, withdrawal, and refresher rationale.
- **FixTrack:** require hazard, people exposed, risk, interim control, source track, owner, due date, evidence, independent verification, root cause, effectiveness, and recurrence/learning.

## Recommended priority order

### P0 — prevent misleading or unsafe reliance

- Fix cross-tenant document/object access and exact-origin validation.
- Protect public links and mobile/session credentials.
- Add immutable revision history and closure integrity to every compliance record.
- Add retention/hold/deletion safeguards and an evidential export package.
- Publish a clear non-certification boundary and customer responsibility statement.

### P1 — make the high-risk tracks inspection-useful

- Fire risk assessment and responsible-person linkage.
- HACCP/allergen/traceability/calibration/verification model.
- Legionella written scheme and competent-person evidence.
- RIDDOR decision/deadline/submission/investigation model.
- PAT/PUWER risk, competence, isolation/retest and calibration model.
- Contractor competence, RAMS, permits, induction, supervision, and close-out model.

### P2 — privacy and operational accountability

- Privacy notices, RoPA, DPIA/Article 9 classification, DSAR cases, breach register, processor register, transfers, and retention schedule.
- Backup/restore, incident exercises, key rotation, access reviews, supplier risk, and security training.
- Complete route-level authorisation matrix and endpoint regression suite.
- Align mobile capability with whichever web tracks are advertised.

## Sources

Primary sources consulted on 10 September 2026:

1. HSE — Risk assessment steps: <https://www.hse.gov.uk/simple-health-safety/risk/steps-needed-to-manage-risk.htm>
2. HSE — RIDDOR reportable incidents: <https://www.hse.gov.uk/riddor/reportable-incidents.htm>
3. HSE — Legionella record keeping: <https://www.hse.gov.uk/legionnaires/what-you-must-do/keeping-records.htm>
4. GOV.UK — Food safety management systems: <https://www.gov.uk/food-safety-management-systems>
5. GOV.UK — Workplace fire safety responsibilities: <https://www.gov.uk/workplace-fire-safety-your-responsibilities>
6. ICO — Accountability and governance: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance>
7. ICO — Subject access requests: <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access>
8. ICO — Personal data breach reporting: <https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach>
9. EUR-Lex — Regulation (EU) 2016/679 (GDPR): <https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng>
10. European Commission — NIS2 Directive: <https://digital-strategy.ec.europa.eu/en/policies/nis2-directive>

## Evidence reviewed

- `artifacts/api-server/src/lib/ukComplianceGuidance.ts`
- `artifacts/api-server/src/middleware/requireAuth.ts`
- `artifacts/api-server/src/middleware/dailyEntryCutoff.ts`
- `artifacts/api-server/src/lib/audit.ts`
- `artifacts/api-server/src/routes/audit-events.ts`
- `artifacts/api-server/src/routes/export.ts`
- `artifacts/api-server/src/routes/storage.ts`
- `artifacts/api-server/src/routes/documents.ts`
- `artifacts/api-server/src/routes/sign-off.ts`
- `artifacts/api-server/src/lib/offboarding.ts`
- `artifacts/api-server/src/routes/fire-safety.ts`
- `artifacts/api-server/src/routes/food-safety.ts`
- `artifacts/api-server/src/routes/legionella.ts`
- `artifacts/api-server/src/routes/fix-track.ts`
- `artifacts/api-server/src/routes/incidents.ts`
- `artifacts/api-server/src/routes/pat-track.ts`
- `artifacts/api-server/src/routes/contractors.ts`
- `artifacts/api-server/src/routes/contractor-portal.ts`
- `artifacts/api-server/src/routes/green-track.ts`
- `artifacts/api-server/src/routes/pool-track.ts`
- `artifacts/api-server/src/routes/swim-track.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/compliance-tracker/src/App.tsx`
- relevant schemas under `lib/db/src/schema/`
- relevant route and isolation tests under `artifacts/api-server/tests/` and `artifacts/compliance-tracker/tests/`
