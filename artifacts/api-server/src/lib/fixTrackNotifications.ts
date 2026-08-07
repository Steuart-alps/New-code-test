import crypto from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sendEmail, escapeHtml } from "./email";

// ── Token generation ──────────────────────────────────────────────────────────

export interface ActionTokens {
  bookedToken: string;
  completedToken: string;
}

/**
 * Mint two one-time tokens (booked + completed) for a contractor job email.
 * Tokens expire after 30 days and can only be used once.
 */
export async function generateActionTokens(
  issueId: number,
  clientId: number,
  contractorId: number,
): Promise<ActionTokens> {
  const bookedToken    = crypto.randomBytes(32).toString("hex");
  const completedToken = crypto.randomBytes(32).toString("hex");
  const expiresAt      = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.execute(sql`
    INSERT INTO fix_track_action_tokens (token, issue_id, client_id, contractor_id, action, expires_at)
    VALUES
      (${bookedToken},    ${issueId}, ${clientId}, ${contractorId}, 'booked',    ${expiresAt}),
      (${completedToken}, ${issueId}, ${clientId}, ${contractorId}, 'completed', ${expiresAt})
  `);

  return { bookedToken, completedToken };
}

// ── Email ─────────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  electrical:    "Electrical",
  plumbing:      "Plumbing",
  gas:           "Gas",
  structural:    "Structural",
  equipment:     "Equipment",
  hvac:          "HVAC",
  it_comms:      "IT / Comms",
  safety_hazard: "Safety Hazard",
  cleaning:      "Cleaning",
  general:       "General",
};

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "🔴 URGENT",
  high:   "🟠 High",
  medium: "🟡 Medium",
  low:    "🟢 Low",
};

export interface ContractorAssignmentOpts {
  contractorName:   string;
  contractorEmail:  string;
  issueTitle:       string;
  issueType:        string;
  issuePriority:    string;
  issueLocation:    string;
  issueDescription: string | null | undefined;
  siteName:         string | null | undefined;
  companyName:      string;
  bookedToken:      string;
  completedToken:   string;
  baseUrl:          string;
  clientId:         number;
  siteDocuments?:   { name: string; url: string }[];
}

export async function sendContractorAssignmentEmail(opts: ContractorAssignmentOpts): Promise<void> {
  const {
    contractorName, contractorEmail, issueTitle, issueType, issuePriority,
    issueLocation, issueDescription, siteName, companyName,
    bookedToken, completedToken, baseUrl, clientId, siteDocuments,
  } = opts;

  const safeName     = escapeHtml(contractorName);
  const safeTitle    = escapeHtml(issueTitle);
  const safeType     = escapeHtml(TYPE_LABEL[issueType] ?? issueType);
  const safePriority = PRIORITY_LABEL[issuePriority] ?? escapeHtml(issuePriority);
  const safeLocation = escapeHtml(issueLocation);
  const safeDesc     = issueDescription ? escapeHtml(issueDescription) : null;
  const safeSite     = siteName ? escapeHtml(siteName) : null;
  const safeCompany  = escapeHtml(companyName);

  const bookedUrl    = `${baseUrl}/api/fix-track/action/${bookedToken}`;
  const completedUrl = `${baseUrl}/api/fix-track/action/${completedToken}`;

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
  <p style="font-size:12px;color:#94a3b8;margin-bottom:16px;font-weight:600;letter-spacing:.05em">COMPLYTRACK · JOB ASSIGNED</p>
  <h2 style="margin:0 0 6px">New Maintenance Job</h2>
  <p style="color:#64748b;margin:0 0 20px;font-size:14px">
    Dear ${safeName}, you have been assigned a job by <strong>${safeCompany}</strong>.
  </p>

  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #3b82f6;border-radius:8px;padding:16px 20px;margin:0 0 20px">
    <h3 style="margin:0 0 12px;font-size:17px;color:#0f172a">${safeTitle}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="color:#64748b;padding:3px 0;width:90px">Type</td>     <td style="font-weight:600">${safeType}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Priority</td><td style="font-weight:600">${safePriority}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Location</td><td>${safeLocation}</td></tr>
      ${safeSite ? `<tr><td style="color:#64748b;padding:3px 0">Site</td><td>${safeSite}</td></tr>` : ""}
    </table>
    ${safeDesc ? `<p style="margin:12px 0 0;color:#475569;font-size:13px;border-top:1px solid #e2e8f0;padding-top:10px">${safeDesc}</p>` : ""}
  </div>

  <p style="font-size:14px;color:#475569;margin:0 0 16px">Please update the job status by clicking one of the buttons below:</p>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
    <tr>
      <td style="padding:0 6px 0 0">
        <a href="${bookedUrl}"
           style="display:block;background:#f59e0b;color:#fff;text-decoration:none;
                  padding:14px 0;border-radius:8px;font-weight:700;font-size:15px;text-align:center">
          📅 Mark as Booked
        </a>
      </td>
      <td style="padding:0 0 0 6px">
        <a href="${completedUrl}"
           style="display:block;background:#10b981;color:#fff;text-decoration:none;
                  padding:14px 0;border-radius:8px;font-weight:700;font-size:15px;text-align:center">
          ✅ Mark as Completed
        </a>
      </td>
    </tr>
  </table>

  ${siteDocuments?.length ? `
  <div style="margin:0 0 20px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
    <p style="font-size:13px;font-weight:700;color:#374151;margin:0 0 10px">
      📎 Site Documents
    </p>
    ${siteDocuments.map(d => `
    <div style="margin-bottom:6px">
      <a href="${d.url}" style="font-size:13px;color:#2563eb;text-decoration:none">
        ${escapeHtml(d.name)}
      </a>
    </div>`).join("")}
    <p style="font-size:11px;color:#94a3b8;margin:10px 0 0">Links expire in 30 days.</p>
  </div>` : ""}

  <p style="font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:16px">
    This job was assigned by ${safeCompany}. These links are valid for 30 days and can only be used once.
    If this email was sent in error, please ignore it.
  </p>
</div>`;

  const priorityPrefix = issuePriority === "urgent" ? "[URGENT] " : "";
  await sendEmail({
    to:      contractorEmail,
    subject: `${priorityPrefix}Job Assigned: ${issueTitle}${siteName ? ` — ${siteName}` : ""}`,
    html,
    clientId,
  });
}

// ── Quote request email ───────────────────────────────────────────────────────

export interface ContractorQuoteOpts {
  contractorName:   string;
  contractorEmail:  string;
  issueTitle:       string;
  issueType:        string;
  issuePriority:    string;
  issueLocation:    string;
  issueDescription: string | null | undefined;
  siteName:         string | null | undefined;
  companyName:      string;
  replyTo?:         string | null;
  clientId:         number;
  siteDocuments?:   { name: string; url: string }[];
}

/**
 * Ask a contractor for a quotation for a job — no assignment, no action
 * buttons. The contractor replies by email with their quote.
 */
export async function sendContractorQuoteEmail(opts: ContractorQuoteOpts): Promise<void> {
  const {
    contractorName, contractorEmail, issueTitle, issueType, issuePriority,
    issueLocation, issueDescription, siteName, companyName, clientId, siteDocuments,
  } = opts;

  const safeName     = escapeHtml(contractorName);
  const safeTitle    = escapeHtml(issueTitle);
  const safeType     = escapeHtml(TYPE_LABEL[issueType] ?? issueType);
  const safePriority = PRIORITY_LABEL[issuePriority] ?? escapeHtml(issuePriority);
  const safeLocation = escapeHtml(issueLocation);
  const safeDesc     = issueDescription ? escapeHtml(issueDescription) : null;
  const safeSite     = siteName ? escapeHtml(siteName) : null;
  const safeCompany  = escapeHtml(companyName);

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
  <p style="font-size:12px;color:#94a3b8;margin-bottom:16px;font-weight:600;letter-spacing:.05em">COMPLYTRACK · QUOTE REQUEST</p>
  <h2 style="margin:0 0 6px">Quotation Requested</h2>
  <p style="color:#64748b;margin:0 0 20px;font-size:14px">
    Dear ${safeName}, <strong>${safeCompany}</strong> would like a quotation for the following work.
    This is a request for a quote only — the job has not been assigned.
  </p>

  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #8b5cf6;border-radius:8px;padding:16px 20px;margin:0 0 20px">
    <h3 style="margin:0 0 12px;font-size:17px;color:#0f172a">${safeTitle}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="color:#64748b;padding:3px 0;width:90px">Type</td>     <td style="font-weight:600">${safeType}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Priority</td><td style="font-weight:600">${safePriority}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Location</td><td>${safeLocation}</td></tr>
      ${safeSite ? `<tr><td style="color:#64748b;padding:3px 0">Site</td><td>${safeSite}</td></tr>` : ""}
    </table>
    ${safeDesc ? `<p style="margin:12px 0 0;color:#475569;font-size:13px;border-top:1px solid #e2e8f0;padding-top:10px">${safeDesc}</p>` : ""}
  </div>

  <p style="font-size:14px;color:#475569;margin:0 0 16px">
    Please reply to this email with your quotation, including cost, availability, and any assumptions.
  </p>

  ${siteDocuments?.length ? `
  <div style="margin:0 0 20px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
    <p style="font-size:13px;font-weight:700;color:#374151;margin:0 0 10px">📎 Site Documents</p>
    ${siteDocuments.map(d => `
    <div style="margin-bottom:6px">
      <a href="${d.url}" style="font-size:13px;color:#2563eb;text-decoration:none">${escapeHtml(d.name)}</a>
    </div>`).join("")}
    <p style="font-size:11px;color:#94a3b8;margin:10px 0 0">Links expire in 30 days.</p>
  </div>` : ""}

  <p style="font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:16px">
    This quote request was sent by ${safeCompany} via ComplyTrack. If this email was sent in error, please ignore it.
  </p>
</div>`;

  await sendEmail({
    to:      contractorEmail,
    subject: `Quote Requested: ${issueTitle}${siteName ? ` — ${siteName}` : ""}`,
    html,
    clientId,
  });
}
