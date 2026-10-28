// Which Claude model each AI feature uses, and how hard it thinks. Kept free
// of imports so the AI reading code and its pure tests can use it.
//
// Agreed with Steuart on 2026-10-27: the cheapest model that does each job
// well, so the AI add-on's allowance goes further.
// - Simple list imports (contractors, rooms, call points, GreenTrack, staff):
//   Claude Haiku 5.5, low effort.
// - Certificates and PAT registers: Claude Sonnet 5.5, low effort.
// - Audit and inspection reports: Claude Opus 5.5, medium effort.
// - COSHH drafts (not built yet): Claude Opus 5.5, high effort.
// - The help chat (not built yet): low effort.
// Each feature's model and effort can be changed on Render without a release
// (the *_MODEL and *_EFFORT variables below). Letting businesses choose for
// themselves is on the future developments roadmap.

export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export type AiModelFeature =
  | "list_reading"
  | "register_reading"
  | "certificate_reading"
  | "report_reading"
  | "coshh_drafting"
  | "help_chat";

interface AiModelSetting {
  model: string;
  effort: AiEffort;
  /** Render variables that override the model and the effort. */
  modelEnv: string;
  effortEnv: string;
}

export const AI_MODEL_SETTINGS: Record<AiModelFeature, AiModelSetting> = {
  list_reading: { model: "claude-haiku-5-5", effort: "low", modelEnv: "LIST_READING_MODEL", effortEnv: "LIST_READING_EFFORT" },
  register_reading: { model: "claude-sonnet-5-5", effort: "low", modelEnv: "REGISTER_READING_MODEL", effortEnv: "REGISTER_READING_EFFORT" },
  certificate_reading: { model: "claude-sonnet-5-5", effort: "low", modelEnv: "CERTIFICATE_READING_MODEL", effortEnv: "CERTIFICATE_READING_EFFORT" },
  report_reading: { model: "claude-opus-5-5", effort: "medium", modelEnv: "REPORT_READING_MODEL", effortEnv: "REPORT_READING_EFFORT" },
  coshh_drafting: { model: "claude-opus-5-5", effort: "high", modelEnv: "COSHH_DRAFTING_MODEL", effortEnv: "COSHH_DRAFTING_EFFORT" },
  help_chat: { model: "claude-sonnet-5-5", effort: "low", modelEnv: "HELP_CHAT_MODEL", effortEnv: "HELP_CHAT_EFFORT" },
};

/** The model a feature sends its requests to. */
export function aiModelFor(feature: AiModelFeature): string {
  const setting = AI_MODEL_SETTINGS[feature];
  return process.env[setting.modelEnv]?.trim() || setting.model;
}

/** How hard the model thinks for a feature; an unknown value keeps the default. */
export function aiEffortFor(feature: AiModelFeature): AiEffort {
  const setting = AI_MODEL_SETTINGS[feature];
  const value = process.env[setting.effortEnv]?.trim().toLowerCase();
  return AI_EFFORTS.find((effort) => effort === value) ?? setting.effort;
}

/** Claude Haiku has no server-side fallback; sending one is refused or ignored. */
export function hasServerSideFallback(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

/** The model a declined Claude Haiku request is tried again on. */
export const HAIKU_REFUSAL_RETRY_MODEL = "claude-sonnet-5-5";

/**
 * The request settings that hand a declined request to another model inside
 * the same call, for the models that offer it.
 */
export function serverSideFallbackParams(model: string): { betas?: string[]; fallbacks?: "default" } {
  return hasServerSideFallback(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}
