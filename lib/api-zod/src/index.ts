export * from './generated/api';
export * from './generated/types';
export * from './kitchen-temperature';

// Names generated in BOTH ./generated/api and ./generated/types must be
// explicitly re-exported to resolve the export-* ambiguity (TS2308).
// If codegen introduces a new collision, the root typecheck will flag it —
// add the name here, preferring the ./generated/api copy.
export {
  AddPrivacyRetentionVerificationParams,
  GetFoodSafetyRecordByDateParams,
  GetStorageUsageResponse,
  ListFeedbackReportHistoryParams,
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
  SavePATPresetTemplateBody,
  SendRemindersResponse,
  TestEmailResponse,
  UpdateFeedbackReportParams,
  UpdatePrivacyRecordParams,
} from './generated/api';
