import { isServiceEntitled } from "./service-action-outcome";
type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void | Promise<unknown>;
    };
  }
}

const ACTIVATION_PREFIX = "complytrack:analytics:module-activation:";
const FIRST_USE_PREFIX = "complytrack:analytics:module-first-use:";
const FIRST_WORK_PREFIX = "complytrack:analytics:module-first-work:";

function storageKey(prefix: string, clientId: number, module: string): string {
  // The client id scopes browser-side deduplication only; it is never sent to
  // analytics, so custom events do not identify a tenant or person.
  return `${prefix}${clientId}:${module}`;
}

function hasStored(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function store(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Tracking remains best-effort when storage is unavailable.
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Tracking must never affect the product flow.
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;
  try {
    void Promise.resolve(window.umami?.track(name, data)).catch(() => {
      // A rejected tracker request must also remain harmless.
    });
  } catch {
    // Analytics must never break the app.
  }
}

/** Track confirmed Settings outcomes; never copy response or account data. */
export function trackServiceActionOutcome(
  serviceKey: string,
  action: "add" | "remove",
  result: { ok: boolean; entitled?: unknown; paymentPending?: boolean },
): boolean {
  if (result.ok !== true || result.paymentPending
    || (action === "add" && !isServiceEntitled(serviceKey, result.entitled))) return false;
  trackEvent("service_action_succeeded", { service_key: serviceKey, action });
  return true;
}

/** Only coarse export scope is sent; never send site ids or record content. */
export function trackTrainingMatrixDownload(siteFilter: string): void {
  trackEvent("training_matrix_download_started", {
    site_scope: siteFilter === "all" ? "all_sites" : "selected_site",
  });
}

/** Records one successful paid activation per client/module activation cycle. */
export function trackModuleActivation(clientId: number | null, module: string): void {
  if (clientId === null || typeof window === "undefined") return;
  const activationKey = storageKey(ACTIVATION_PREFIX, clientId, module);
  if (hasStored(activationKey)) return;

  store(activationKey);
  // A reactivation starts a new activation-to-first-use journey.
  remove(storageKey(FIRST_USE_PREFIX, clientId, module));
  remove(storageKey(FIRST_WORK_PREFIX, clientId, module));
  trackEvent("module_activation_succeeded", { module });
}

/** Ends an activation cycle when a paid module is removed. */
export function clearModuleActivation(clientId: number | null, module: string): void {
  if (clientId === null || typeof window === "undefined") return;
  remove(storageKey(ACTIVATION_PREFIX, clientId, module));
  remove(storageKey(FIRST_USE_PREFIX, clientId, module));
  remove(storageKey(FIRST_WORK_PREFIX, clientId, module));
}

/** Records the first route use after a tracked successful paid activation. */
export function trackModuleFirstUse(clientId: number | null, module: string): void {
  if (clientId === null || typeof window === "undefined") return;
  if (!hasStored(storageKey(ACTIVATION_PREFIX, clientId, module))) return;

  const firstUseKey = storageKey(FIRST_USE_PREFIX, clientId, module);
  if (hasStored(firstUseKey)) return;
  store(firstUseKey);
  trackEvent("module_first_used", { module });
}
export type CompletedWorkActivity = "check_completed" | "record_saved" | "acknowledgement_recorded";

type CompletedWorkRule = readonly [
  pattern: RegExp,
  modules: readonly string[],
  activity: CompletedWorkActivity,
];

// Allowlist of successful POSTs that create a compliance record or complete a
// check. Paths are relative to the API base, with ids matched as `\d+`.
// Configuration, asset registers (tubs, bikes, machines, rooms, outlets),
// uploads, edits and deletes are deliberately absent: they are set-up or
// corrections, not evidence that the activated service is doing work.
// Where one API serves several services, only services with a tracked
// activation in this browser are recorded (see trackModuleWorkCompleted).
const COMPLETED_WORK_RULES: readonly CompletedWorkRule[] = [
  [/^\/fire-safety$/, ["firetrack"], "check_completed"],
  [/^\/legionella$/, ["legionellatrack"], "check_completed"],
  [/^\/hot-tub$/, ["hottubtrack"], "check_completed"],
  [/^\/tree-track$/, ["treetrack"], "check_completed"],
  [/^\/premises-track$/, ["premisestrack"], "check_completed"],
  [/^\/pool-track$/, ["pooltrack", "aquatrack"], "check_completed"],
  [/^\/swim-track\/surveillance$/, ["swimtrack", "aquatrack"], "check_completed"],
  [/^\/swim-track\/(sessions|first-aid|incidents)$/, ["swimtrack", "aquatrack"], "record_saved"],
  [/^\/room-track\/checks$/, ["roomtrack"], "check_completed"],
  [/^\/daily-track-am$/, ["dailytrack_am"], "check_completed"],
  [/^\/daily-track-pm(\/signoffs)?$/, ["dailytrack_pm"], "check_completed"],
  [/^\/food-safety(\/append)?$/, ["kitchentrack"], "record_saved"],
  [/^\/kitchen-weekly\/(weekly|probe)$/, ["kitchentrack"], "check_completed"],
  [/^\/kitchen-cleaning\/logs$/, ["kitchentrack"], "check_completed"],
  [/^\/fix-track\/issues$/, ["fixtrack"], "record_saved"],
  [/^\/doc-track\/documents$/, ["doctrack"], "record_saved"],
  [/^\/doc-track\/documents\/\d+\/acknowledge$/, ["doctrack"], "acknowledgement_recorded"],
  [/^\/safe-track\/(risk-assessments|sops|handbook)\/\d+\/(self-)?acknowledge$/, ["safetrack"], "acknowledgement_recorded"],
  [/^\/train-track\/records$/, ["traintrack"], "record_saved"],
  [/^\/bike-track\/services$/, ["biketrack"], "check_completed"],
  [/^\/bike-track\/hires(\/\d+\/return)?$/, ["biketrack"], "record_saved"],
  [/^\/green-track\/(pre-use-checks|puwer-inspections)$/, ["greentrack"], "check_completed"],
  [/^\/green-track\/(service-records|defects|fuel-logs)$/, ["greentrack"], "record_saved"],
  [/^\/incidents$/, ["incidenttrack"], "record_saved"],
  [/^\/pat-track\/tests$/, ["pattrack"], "check_completed"],
  [/^\/pat-track\/(certificates|replacements|failures)$/, ["pattrack"], "record_saved"],
  [/^\/pest-track\/visits$/, ["pesttrack"], "check_completed"],
  [/^\/pest-track\/activity$/, ["pesttrack"], "record_saved"],
];

function apiPath(url: string): string {
  let path = url.split(/[?#]/, 1)[0] ?? "";
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) path = new URL(path).pathname;
  } catch {
    return "";
  }
  const apiIndex = path.indexOf("/api/");
  if (apiIndex >= 0) path = path.slice(apiIndex + 4);
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Maps a state-changing request to an allowlisted service/activity, or null. */
export function classifyCompletedWork(
  method: string,
  url: string,
): { modules: readonly string[]; activity: CompletedWorkActivity } | null {
  if (method.toUpperCase() !== "POST") return null;
  const path = apiPath(url);
  const rule = COMPLETED_WORK_RULES.find(([pattern]) => pattern.test(path));
  return rule ? { modules: rule[1], activity: rule[2] } : null;
}

/**
 * Records the first saved compliance record or completed check after a
 * tracked successful activation, once per client/module activation cycle.
 * Only the allowlisted module and activity are sent: never client or site
 * identity, record ids, request/response content or billing details.
 */
export function trackModuleWorkCompleted(
  clientId: number | null,
  module: string,
  activity: CompletedWorkActivity,
): void {
  if (clientId === null || typeof window === "undefined") return;
  if (!hasStored(storageKey(ACTIVATION_PREFIX, clientId, module))) return;

  const firstWorkKey = storageKey(FIRST_WORK_PREFIX, clientId, module);
  if (hasStored(firstWorkKey)) return;
  store(firstWorkKey);
  trackEvent("module_first_work_completed", { module, activity });
}

/**
 * Builds an API mutation observer. The client is captured when the request
 * starts, so switching client mid-request cannot misattribute the outcome,
 * and the event is only considered after a successful response.
 */
export function createCompletedWorkObserver(
  getClientId: () => number | null,
): (method: string, url: string) => (() => void) | void {
  return (method, url) => {
    const work = classifyCompletedWork(method, url);
    if (!work) return;
    const clientId = getClientId();
    return () => {
      for (const module of work.modules) trackModuleWorkCompleted(clientId, module, work.activity);
    };
  };
}
