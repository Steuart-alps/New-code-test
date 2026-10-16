export {
  assessKitchenTemperatures, parseKitchenTemperatureRules, kitchenTemperatureRulesSchema,
  temperatureRangeLabel, kitchenFailureValue, kitchenHoldRequirement, DEFAULT_KITCHEN_TEMPERATURE_RULES,
  type KitchenTemperatureRules, type KitchenTemperatureFailure,
} from '@workspace/api-zod/kitchen-temperature';
export {
  kitchenWeeklyAttentionAnswer, kitchenWeeklyNeedsAttention, kitchenWeeklyResult,
} from '@workspace/api-zod/kitchen-weekly';
export * from './generated/api';
export * from './generated/api.schemas';
export {
  setBaseUrl,
  setAuthTokenGetter,
  setClientIdGetter,
  setUnauthorizedHandler,
  setPaymentRequiredHandler,
  setMutationObserver,
  setCsrfTokenProvider,
  callerChoseClientId,
  appendClientId,
} from "./custom-fetch";
export type { AuthTokenGetter, ApiMutationObserver, CsrfTokenProvider } from "./custom-fetch";
