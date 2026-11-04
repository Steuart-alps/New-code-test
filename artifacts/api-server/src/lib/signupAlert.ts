import { sendSystemEmail, escapeHtml, getPublicAppUrl } from "./email";
import { SERVICES, BUNDLE_LABEL } from "./services";
import { logger } from "./logger";

/**
 * Tells ALPS (ADMIN_EMAIL) about each new self-signup, so someone can welcome
 * the business personally while its trial is running. One email per sign-up,
 * to ALPS only; nothing goes to the new business. Without ADMIN_EMAIL it only
 * logs. Delivery is best-effort and never affects registration.
 */
export async function sendNewSignupAlert(signup: {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  businessType?: string | null;
  services?: readonly string[] | null;
  bundle?: boolean | null;
  trialEndsAt: Date;
}): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    logger.info("ADMIN_EMAIL not configured — new sign-up alert not sent");
    return;
  }

  const picked = signup.bundle
    ? BUNDLE_LABEL
    : (signup.services ?? [])
        .map((key) => (SERVICES as Record<string, { label: string }>)[key]?.label ?? key)
        .join(", ") || "None picked yet";
  const trialEnds = signup.trialEndsAt.toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London",
  });
  const rows: Array<[string, string]> = [
    ["Business", signup.businessName],
    ["Owner", signup.ownerName],
    ["Email", signup.ownerEmail],
    ["Business type", signup.businessType || "Not given"],
    ["Modules picked", picked],
    ["Free trial ends", trialEnds],
  ];
  const appUrl = getPublicAppUrl().replace(/\/$/, "");

  await sendSystemEmail({
    to: adminEmail,
    subject: `New ComplyTrack sign-up: ${signup.businessName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1e293b;">New ComplyTrack sign-up</h2>
        <p>A new business has started a free trial.</p>
        <table style="border-collapse: collapse; margin: 16px 0;">
          ${rows.map(([label, value]) => `<tr><td style="padding: 4px 16px 4px 0; color: #64748b;">${label}</td><td style="padding: 4px 0;"><strong>${escapeHtml(value)}</strong></td></tr>`).join("")}
        </table>
        <p>A personal welcome during the trial is the best chance of keeping them. The business is listed under Clients in <a href="${appUrl}">ComplyTrack</a>.</p>
      </div>
    `,
    text: `New ComplyTrack sign-up\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\nThe business is listed under Clients in ComplyTrack: ${appUrl}`,
  });
}
