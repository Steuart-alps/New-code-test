export {
  assessKitchenTemperatures, parseKitchenTemperatureRules, kitchenTemperatureRulesSchema,
  temperatureRangeLabel, kitchenFailureValue, kitchenHoldRequirement, DEFAULT_KITCHEN_TEMPERATURE_RULES,
  type KitchenTemperatureRules, type KitchenTemperatureFailure,
} from '@workspace/api-zod/kitchen-temperature';
export {
  parseSafeTrackReminderSettings, nextSafeTrackReminder, SAFE_TRACK_REMINDER_CHECK_MINUTES,
  type SafeTrackReminderSettings, type SafeTrackReminderPreview,
} from '@workspace/api-zod/safe-track-reminder-schedule';
export {
  FOOD_JURISDICTIONS, KITCHEN_TEMPERATURE_GUIDANCE, isFoodJurisdiction, kitchenTemperatureGuidance,
  kitchenTemperatureGuidanceRules, type FoodJurisdiction, type KitchenTemperatureGuidance,
} from '@workspace/api-zod/kitchen-temperature';
export {
  NSTS_SPRAYER_CATEGORIES, NSTS_TEST_INSPECTION_TYPE, isNstsSprayerCategory, nstsNextTestDate, nstsFirstTestDueDate,
  nstsStatus, type NstsSprayerCategory, type NstsStatus,
} from '@workspace/api-zod/nsts-sprayer-tests';
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
  setRecordSignatureHandler,
  signatureRequiredInfo,
  RECORD_SIGNATURE_HEADER,
  SIGNATURE_REQUIRED_CODE,
  callerChoseClientId,
  appendClientId,
} from "./custom-fetch";
export type {
  AuthTokenGetter, ApiMutationObserver, CsrfTokenProvider, OverrideReasonHandler, OverrideReasonRequest,
  RecordSignatureHandler, RecordSignatureRequest,
} from "./custom-fetch";
