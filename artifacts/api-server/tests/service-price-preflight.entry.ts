// Bundled by service-price-preflight.mjs. The database-backed check is not
// invoked here; this exposes the deterministic catalogue comparison used by it.
export {
  SERVICE_PRICE_CATALOGUE,
  evaluateServicePricePreflight,
  getServicePriceReadinessBlocker,
  addonPurchaseAvailability,
  ADDON_KEYS,
} from "../src/lib/services";