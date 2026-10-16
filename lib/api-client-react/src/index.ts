export {
  assessKitchenTemperatures, parseKitchenTemperatureRules, kitchenTemperatureRulesSchema,
  temperatureRangeLabel, kitchenFailureValue, kitchenHoldRequirement, DEFAULT_KITCHEN_TEMPERATURE_RULES,
  type KitchenTemperatureRules, type KitchenTemperatureFailure,
} from '@workspace/api-zod/kitchen-temperature';
export {
  FOOD_JURISDICTIONS, KITCHEN_TEMPERATURE_GUIDANCE, isFoodJurisdiction, kitchenTemperatureGuidance,
  kitchenTemperatureGuidanceRules, type FoodJurisdiction, type KitchenTemperatureGuidance,
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
  setOverrideReasonHandler,
  isReplayableBody,
  overrideReasonMessage,
  OVERRIDE_REASON_HEADER,
  OVERRIDE_REASON_REQUIRED_CODE,
  callerChoseClientId,
  appendClientId,
} from "./custom-fetch";
export type {
  AuthTokenGetter, ApiMutationObserver, CsrfTokenProvider, OverrideReasonHandler, OverrideReasonRequest,
} from "./custom-fetch";
