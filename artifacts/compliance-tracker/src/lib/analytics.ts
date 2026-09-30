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
  trackEvent("module_activation_succeeded", { module });
}

/** Ends an activation cycle when a paid module is removed. */
export function clearModuleActivation(clientId: number | null, module: string): void {
  if (clientId === null || typeof window === "undefined") return;
  remove(storageKey(ACTIVATION_PREFIX, clientId, module));
  remove(storageKey(FIRST_USE_PREFIX, clientId, module));
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