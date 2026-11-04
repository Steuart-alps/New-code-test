/**
 * Read-only check of the Stripe Tax settings that billing depends on.
 *
 * Checkout and every invoice the app creates turn on Stripe's automatic tax,
 * but the settings it needs live in the Stripe dashboard (Settings > Tax):
 * without a head office address Stripe cannot calculate tax and checkout
 * fails; the "inferred by currency" default treats GBP prices as
 * VAT-inclusive, contradicting the "+ VAT" shown on the site; and without an
 * active UK registration no VAT is charged. ALPS is VAT registered, so each of
 * these is reported in the logs and as the `stripeTax` note in /readyz. The
 * check never changes Stripe settings and never affects readiness.
 */
import { logger } from "./logger";
import { setReadinessNote } from "./readinessDetails";
import { getStripeCredentialSource, getUncachableStripeClient } from "./stripeClient";

export const STRIPE_TAX_CHECK_CRON = "35 * * * *";

interface TaxSettingsShape {
  status?: string | null;
  defaults?: { tax_behavior?: string | null } | null;
}

interface TaxRegistrationShape {
  country?: string | null;
  status?: string | null;
}

/** Fixed, non-secret descriptions of each problem (shown on the public /readyz). */
export function describeStripeTaxIssues(
  settings: TaxSettingsShape,
  registrations: readonly TaxRegistrationShape[],
): string[] {
  const issues: string[] = [];
  if (settings.status !== "active") {
    issues.push("Stripe Tax is not set up (add the head office address in Stripe Settings > Tax); checkout cannot calculate tax");
  }
  if (settings.defaults?.tax_behavior !== "exclusive") {
    issues.push("Stripe default tax behaviour is not Exclusive, so prices may be treated as including VAT");
  }
  if (!registrations.some((r) => r.country === "GB" && r.status === "active")) {
    issues.push("No active UK VAT registration in Stripe Tax, so no VAT is charged");
  }
  return issues;
}

export async function runStripeTaxCheck(): Promise<string[] | null> {
  if (!getStripeCredentialSource()) return null;
  const stripe = await getUncachableStripeClient();
  const settings = await stripe.tax.settings.retrieve();
  const registrations = await stripe.tax.registrations.list({ status: "active", limit: 100 });
  const issues = describeStripeTaxIssues(settings, registrations.data);
  if (issues.length > 0) {
    logger.warn({ issues }, "Stripe Tax settings need attention");
    setReadinessNote("stripeTax", { issues });
  } else {
    logger.info("Stripe Tax settings checked: UK VAT is charged on top of prices");
    setReadinessNote("stripeTax", null);
  }
  return issues;
}
