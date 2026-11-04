import { getStripeSync } from "./stripeClient";
import { syncClientSubscriptionState } from "./subscriptionState";
import { sendCancellationWarningEmail, sendPaymentFailedEmail } from "./offboarding";
import { recordPlanChange, sendCancellationAlert, sendNewSubscriptionAlert, withdrawCancellation } from "./billingAlerts";
import { logger } from "./logger";

export interface StripeWebhookEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, any>; previous_attributes?: Record<string, any> };
}

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
        "This usually means express.json() parsed the body before reaching this handler. " +
        "FIX: Ensure webhook route is registered BEFORE app.use(express.json())."
      );
    }
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);
  }

  /**
   * Follow-up work after processWebhook has updated the synced Stripe tables.
   * Runs after the 200 is sent; never throws. Each step reads the synced state
   * rather than trusting the (possibly delayed) event payload.
   */
  static async afterSync(event: StripeWebhookEvent): Promise<void> {
    const object = event?.data?.object ?? {};
    const customer = typeof object.customer === "string" ? object.customer : null;
    if (!customer) return;

    if (event.type?.startsWith("customer.subscription.")) {
      // Local plan status, and a resubscription stops any retention countdown.
      await syncClientSubscriptionState(customer)
        .catch((err) => logger.warn({ err }, "Could not sync client subscription state"));

      // Warn when a subscription is cancelled immediately or scheduled to
      // cancel at period end.
      const isCancelled = event.type === "customer.subscription.deleted";
      const isCancelAtPeriodEnd = event.type === "customer.subscription.updated" && object.cancel_at_period_end === true;
      if (isCancelled || isCancelAtPeriodEnd) {
        const accessEndsAt: string | number | null =
          typeof object.cancel_at === "number" ? object.cancel_at :
          typeof object.current_period_end === "number" ? object.current_period_end :
          null;
        await sendCancellationWarningEmail({ stripeCustomerId: customer, accessEndsAt })
          .catch((err) => logger.warn({ err }, "Cancellation warning email failed"));
      }

      // For ALPS's Monday digest: cancellations, and modules, AI, storage or
      // sites added or removed.
      await sendCancellationAlert(object)
        .catch((err) => logger.warn({ err }, "Cancellation could not be recorded for ALPS"));
      if (event.type === "customer.subscription.updated") {
        if (event.data?.previous_attributes?.cancel_at_period_end === true) {
          await withdrawCancellation(object)
            .catch((err) => logger.warn({ err }, "Could not withdraw a cancellation from the ALPS digest"));
        }
        await recordPlanChange(event)
          .catch((err) => logger.warn({ err }, "Plan change for the ALPS digest could not be recorded"));
      }
      return;
    }

    // The first paid invoice of a subscription: a business has started
    // paying (recorded once per subscription for ALPS's Monday digest).
    if (event.type === "invoice.paid") {
      await sendNewSubscriptionAlert(object)
        .catch((err) => logger.warn({ err }, "New subscription could not be recorded for ALPS"));
      return;
    }

    if (event.type === "invoice.payment_failed" && typeof object.id === "string") {
      await sendPaymentFailedEmail({
        stripeCustomerId: customer,
        invoiceId: object.id,
        amountDue: typeof object.amount_due === "number" ? object.amount_due : null,
        currency: typeof object.currency === "string" ? object.currency : null,
        hostedInvoiceUrl: typeof object.hosted_invoice_url === "string" ? object.hosted_invoice_url : null,
      }).catch((err) => logger.warn({ err }, "Payment failed email could not be sent"));
    }
  }
}
