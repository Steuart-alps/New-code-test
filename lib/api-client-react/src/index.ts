export {
  assessKitchenTemperatures, parseKitchenTemperatureRules, kitchenTemperatureRulesSchema,
  temperatureRangeLabel, kitchenFailureValue, kitchenHoldRequirement, DEFAULT_KITCHEN_TEMPERATURE_RULES,
  type KitchenTemperatureRules, type KitchenTemperatureFailure,
} from '@workspace/api-zod/kitchen-temperature';
export * from './generated/api';
export * from './generated/api.schemas';
export {
  setBaseUrl,
  setAuthTokenGetter,
  setClientIdGetter,
  setUnauthorizedHandler,
  setPaymentRequiredHandler,
  setMutationObserver,
} from "./custom-fetch";
export type { AuthTokenGetter, ApiMutationObserver } from "./custom-fetch";
