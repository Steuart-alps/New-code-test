// Only native/device I/O and app plumbing are substituted. The controls screen,
// StatusBadge, React, TanStack Query and the generated API client are the
// production implementations; requests are real HTTP answered by Playwright.
import React from 'react';

const testProps = (testID) => (testID ? { 'data-testid': testID } : {});
const host = (tag) => ({ children, onPress, testID }) => React.createElement(
  tag,
  { ...testProps(testID), ...(onPress ? { onClick: onPress } : {}), ...(tag === 'button' ? { type: 'button' } : {}) },
  children,
);
export const View = host('div'), Text = host('span'), TouchableOpacity = host('button'), ScrollView = host('div');
export const ActivityIndicator = () => React.createElement('span', null, 'Loading');
export const RefreshControl = () => null;
export const Feather = () => null;
export const StyleSheet = { create: (styles) => styles, hairlineWidth: 1 };
export const Stack = { Screen: ({ options }) => React.createElement('h1', { 'data-testid': 'screen-title' }, options?.title ?? '') };
export const pushes = [];
export const useRouter = () => ({ back() {}, push(path) { pushes.push(path); }, replace() {} });
export const useLocalSearchParams = () => window.controlsParams;
export const useColors = () => new Proxy({}, { get: () => '#123456' });
export const useAuth = () => ({ user: { id: 5, clientId: 23, name: 'Mobile Manager', role: 'client_staff' } });
export async function apiFetch(path, options = {}) {
  const response = await fetch(`https://controls-mobile.test${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-token', ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data;
}
