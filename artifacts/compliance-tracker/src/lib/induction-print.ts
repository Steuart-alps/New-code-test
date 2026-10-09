export const INDUCTION_SECTIONS = [
  { key: "accident_hazard", label: "Accident & Hazard Reporting" },
  { key: "asbestos", label: "Asbestos Log" },
  { key: "coshh", label: "COSHH" },
  { key: "communication_hs", label: "Communication & Consultation on H&S" },
  { key: "dse", label: "Display Screen Equipment (DSE)" },
  { key: "fire_emergency", label: "Fire & Emergency Procedures" },
  { key: "first_aid", label: "First Aid Provision" },
  { key: "hs_policy", label: "Health & Safety Policy Statement" },
  { key: "housekeeping_fire", label: "Housekeeping — Fire Safety" },
  { key: "housekeeping_elec", label: "Housekeeping — Electrical Safety" },
  { key: "housekeeping_general", label: "Housekeeping — General Workplace Safety" },
  { key: "infection_control", label: "Infection Control" },
  { key: "manual_handling", label: "Manual Handling" },
  { key: "vehicle_movement", label: "Vehicle Movement" },
  { key: "falls_height", label: "Falls from Height" },
  { key: "work_equipment", label: "Work Equipment" },
  { key: "working_at_height", label: "Working at Height" },
  { key: "lone_working", label: "Lone Working / Personal Safety" },
  { key: "medicines", label: "Medicines" },
  { key: "mobile_phone", label: "Mobile Phone Use" },
  { key: "ppe", label: "Personal Protective Equipment (PPE)" },
  { key: "risk_assessments", label: "Risk Assessments" },
  { key: "wellbeing", label: "Wellbeing" },
  { key: "workplace_facilities", label: "Workplace Facilities" },
] as const;

export type SectionKey = typeof INDUCTION_SECTIONS[number]["key"];
type ChecklistStatus = "yes" | "no" | "na" | "";
export interface ChecklistItem { key: SectionKey; status: ChecklistStatus; comments: string }
export interface InductionChecklist { jobTitle: string; department: string; items: ChecklistItem[] }

function defaultChecklist(): InductionChecklist {
  return {
    jobTitle: "",
    department: "",
    items: INDUCTION_SECTIONS.map(section => ({ key: section.key, status: "", comments: "" })),
  };
}

export function parseChecklist(raw?: string | null): InductionChecklist {
  if (!raw) return defaultChecklist();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaultChecklist();
    const data = parsed as Record<string, unknown>;
    const items = Array.isArray(data.items) ? data.items : [];
    const existing = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      if (item && typeof item === "object" && typeof item.key === "string") {
        existing.set(item.key, item);
      }
    }
    return {
      jobTitle: typeof data.jobTitle === "string" ? data.jobTitle : "",
      department: typeof data.department === "string" ? data.department : "",
      items: INDUCTION_SECTIONS.map(section => {
        const item = existing.get(section.key);
        const status = item?.status;
        return {
          key: section.key,
          status: status === "yes" || status === "no" || status === "na" ? status : "",
          comments: typeof item?.comments === "string" ? item.comments : "",
        };
      }),
    };
  } catch {
    return defaultChecklist();
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export interface InductionPrintRecord {
  staffName: string;
  startDate: string;
  completedAt?: string | null;
  checklist?: string | null;
  notes?: string | null;
}

export function renderInductionHtml(record: InductionPrintRecord, site: string): string {
  const checklist = parseChecklist(record.checklist);
  const statusLabel: Record<ChecklistStatus, string> = { yes: "Yes", no: "No", na: "N/A", "": "Not recorded" };
  const rows = INDUCTION_SECTIONS.map((section, index) => {
    const item = checklist.items[index];
    return `<tr><td class="number">${index + 1}</td><td>${escapeHtml(section.label)}</td><td class="status ${escapeHtml(item.status || "blank")}">${escapeHtml(statusLabel[item.status])}</td><td>${escapeHtml(item.comments || "—")}</td></tr>`;
  }).join("");
  return `<!doctype html><html><head><title>Staff Induction - ${escapeHtml(record.staffName)}</title>
    <style>
      @page{size:A4;margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;margin:0;font-size:10pt}
      h1{font-size:20pt;margin:0 0 4px;color:#173b57}.subtitle{margin:0 0 16px;color:#52606d}
      .meta{display:grid;grid-template-columns:1fr 1fr;border:1px solid #9aa5b1;margin-bottom:14px}
      .meta div{padding:7px 9px;border-bottom:1px solid #cbd2d9}.meta div:nth-child(odd){border-right:1px solid #cbd2d9}.meta div:nth-last-child(-n+2){border-bottom:0}
      .label{font-size:8pt;text-transform:uppercase;color:#616e7c;display:block;margin-bottom:2px}.value{font-weight:600}
      table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #9aa5b1;padding:5px 6px;text-align:left;vertical-align:top}
      th{background:#e8f1f7;font-size:8pt;text-transform:uppercase}th:nth-child(1){width:7%}th:nth-child(2){width:35%}th:nth-child(3){width:14%}th:nth-child(4){width:44%}
      .number,.status{text-align:center}.yes{color:#137333;font-weight:bold}.no{color:#b3261e;font-weight:bold}.na{color:#52606d;font-weight:bold}.blank{color:#7b8794}
      .notes{border:1px solid #9aa5b1;margin-top:14px;padding:9px;min-height:58px;white-space:pre-wrap}
      .footer{margin-top:12px;font-size:8pt;color:#616e7c}.controls{margin-bottom:14px}.controls button{background:#173b57;color:white;border:0;padding:9px 14px;border-radius:4px;font-weight:600;cursor:pointer}
      tr{break-inside:avoid}@media print{.controls{display:none}body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
    </style></head><body>
    <div class="controls"><button onclick="window.print()">Print / Save as PDF</button></div>
    <h1>Staff Induction Form</h1><p class="subtitle">Health &amp; Safety Induction Record</p>
    <section class="meta">
      <div><span class="label">Employee name</span><span class="value">${escapeHtml(record.staffName)}</span></div>
      <div><span class="label">Job title</span><span class="value">${escapeHtml(checklist.jobTitle || "—")}</span></div>
      <div><span class="label">Department</span><span class="value">${escapeHtml(checklist.department || "—")}</span></div>
      <div><span class="label">Site</span><span class="value">${escapeHtml(site)}</span></div>
      <div><span class="label">Start date</span><span class="value">${escapeHtml(record.startDate)}</span></div>
      <div><span class="label">Induction completed</span><span class="value">${escapeHtml(record.completedAt || "Not yet completed")}</span></div>
    </section>
    <table><thead><tr><th>No.</th><th>Induction section</th><th>Status</th><th>Comments</th></tr></thead><tbody>${rows}</tbody></table>
    <section class="notes"><span class="label">Manager sign-off notes</span>${escapeHtml(record.notes || "No sign-off notes recorded.")}</section>
    <p class="footer">Once the employee and manager have signed to confirm the induction is complete, place this form on the employee's personnel file.</p>
    </body></html>`;
}