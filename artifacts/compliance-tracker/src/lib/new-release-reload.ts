// When a new release goes live, the hashed script files of the previous one
// are gone. A tab opened before the release still asks for the old files the
// first time someone opens a page it has not loaded yet (pages load on
// demand), so that page cannot load. Reloading fetches the new release, so we
// do that once instead of showing the error page.

const RELOAD_KEY = "complytrack:new-release-reload-at";
// A second failure this soon after an automatic reload is a real fault, not a
// stale tab, so it shows the error page rather than reloading in a loop.
const RELOAD_GUARD_MS = 30_000;

export interface ReloadEnv {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  now: () => number;
  online: () => boolean;
}

function browserEnv(): ReloadEnv {
  let storage: ReloadEnv["storage"] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return {
    storage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
    online: () => navigator.onLine !== false,
  };
}

let reloading = false;

/** True once this page has started an automatic reload. */
export function isReloadingForNewRelease(): boolean {
  return reloading;
}

/**
 * Messages browsers give when a page's script or style file cannot be loaded:
 * Chrome, Firefox and Safari word it differently, and Safari reports the
 * HTML page that used to come back for a missing file as a MIME type error.
 */
const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /is not a valid javascript mime type/i,
  /expected a javascript(-or-wasm)? module script/i,
  /unable to preload css/i,
  /loading (css )?chunk [\w-]+ failed/i,
];

export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Reloads the page once to pick up a new release. Returns false, leaving the
 * page as it is, when offline (a reload would not help), when this tab already
 * reloaded for this reason moments ago, or when the reload cannot be recorded
 * (without a record a broken release could reload forever).
 */
export function reloadForNewRelease(env: ReloadEnv = browserEnv()): boolean {
  if (reloading) return true;
  if (!env.online() || !env.storage) return false;
  try {
    const last = Number(env.storage.getItem(RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && env.now() - last < RELOAD_GUARD_MS) return false;
    env.storage.setItem(RELOAD_KEY, String(env.now()));
  } catch {
    return false;
  }
  reloading = true;
  env.reload();
  return true;
}

/**
 * Vite raises vite:preloadError when an on-demand page or its styles fail to
 * load. The error still reaches the error boundary, which shows a short
 * "loading the latest version" note while the reload happens.
 */
export function installNewReleaseReload(): void {
  window.addEventListener("vite:preloadError", () => {
    reloadForNewRelease();
  });
}

/** Test hook: forget that a reload started. */
export function resetNewReleaseReloadForTests(): void {
  reloading = false;
}
