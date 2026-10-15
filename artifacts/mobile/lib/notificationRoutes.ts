/**
 * Map a push notification's `data.route` hint to a screen this app has.
 *
 * Server reminders are shared with the web app and some carry web paths the
 * mobile app has no screen for (e.g. /contractors, /train-track). Known hints are mapped to the closest mobile screen; any
 * other value opens the home tab instead of an unmatched route.
 *
 * Import-free so tests can load it directly with Node.
 */
export const HOME_ROUTE = '/(tabs)';

const TAB_ROUTES = new Set([
  '/(tabs)',
  '/(tabs)/index',
  '/(tabs)/checks',
  '/(tabs)/issues',
  '/(tabs)/docs',
  '/(tabs)/profile',
]);

const CHECK_SCREENS = new Set([
  'aqua', 'cleaning', 'daily', 'green', 'incident', 'kitchen', 'pat', 'safe-track',
  // app/checks/[type].tsx
  'fire', 'water', 'hot-tub',
]);

// Web paths used by server reminders -> mobile screens.
const WEB_PATHS: Record<string, string> = {
  '/train-track': '/(tabs)/docs?tab=training',
  '/doc-track': '/(tabs)/docs',
  '/fix-track': '/(tabs)/issues',
  '/issues': '/(tabs)/issues',
  // The daily track summary push opens the phone's action list.
  '/track-actions': '/manage/actions',
  '/compliance-hub': '/manage/actions?tab=hub',
  // No contractor screens on mobile yet.
  '/contractors': HOME_ROUTE,
};

export function resolveNotificationRoute(hint: unknown): string {
  if (typeof hint !== 'string') return HOME_ROUTE;
  const [rawPath] = hint.trim().split(/[?#]/, 1);
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
  if (TAB_ROUTES.has(path)) return path === '/(tabs)/index' ? HOME_ROUTE : path;
  if (path in WEB_PATHS) return WEB_PATHS[path];
  const check = /^\/checks\/([a-z-]+)$/.exec(path);
  if (check && CHECK_SCREENS.has(check[1])) return path;
  if (/^\/issues\/\d{1,9}$/.test(path)) return path;
  return HOME_ROUTE;
}
