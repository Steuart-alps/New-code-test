// Bundled by billing-addon-activation.mjs so Stripe invoice collection can be
// exercised with a deterministic fake rather than a live payment account.
export { collectAddonFirstMonthInvoice } from "../src/lib/billing";