// A QR label scanned while signed out is remembered for this browser tab, so
// signing in goes straight back to the scanned item instead of the dashboard.
const KEY = "complytrack-scan-return";
const SCAN_PATH = /^\/q\/[A-Za-z0-9]{1,16}$/;

export function rememberScanPath(path: string): void {
  if (!SCAN_PATH.test(path)) return;
  try { window.sessionStorage.setItem(KEY, path); } catch { /* storage blocked: sign-in goes to the dashboard */ }
}

export function pendingScanPath(): string | null {
  try {
    const path = window.sessionStorage.getItem(KEY);
    return path && SCAN_PATH.test(path) ? path : null;
  } catch {
    return null;
  }
}

export function clearScanPath(): void {
  try { window.sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
