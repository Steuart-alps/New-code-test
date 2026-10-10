// Only native/device I/O and app plumbing are substituted. PatScreen, React and
// TanStack Query are the production implementations; apiFetch performs real
// HTTP requests that the Playwright test answers with API-shaped fixtures.
import React from 'react';

const testProps = (testID) => (testID ? { 'data-testid': testID } : {});
const host = (tag) => ({ children, onPress, testID, disabled }) => React.createElement(
  tag,
  { ...testProps(testID), ...(onPress ? { onClick: onPress } : {}), ...(tag === 'button' ? { disabled: !!disabled, type: 'button' } : {}) },
  children,
);
export const View = host('div'), Text = host('span'), TouchableOpacity = host('button'), ScrollView = host('div');
export const ActivityIndicator = () => React.createElement('span', null, 'Loading');
export const RefreshControl = () => null;
export const TextInput = ({ value, onChangeText, placeholder, testID }) => React.createElement('input', {
  ...testProps(testID), value: value ?? '', placeholder, onChange: (event) => onChangeText?.(event.target.value),
});
export const Modal = ({ visible, children }) => (visible ? React.createElement('div', { 'data-testid': 'native-modal' }, children) : null);
export const KeyboardAwareScrollViewCompat = ({ children }) => React.createElement('div', null, children);
export const Feather = () => null;
export const Platform = { OS: 'web' };
export const StyleSheet = { create: (styles) => styles };
export const alerts = [];
export const Alert = { alert(title, message) { alerts.push({ title, message }); } };
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
export const routerCalls = [];
export const useRouter = () => ({
  back() { routerCalls.push({ method: 'back' }); },
  push(href) { routerCalls.push({ method: 'push', href }); },
  replace(href) { routerCalls.push({ method: 'replace', href }); },
});
export const NotificationFeedbackType = { Success: 'success', Error: 'error' };
export const notificationAsync = async () => {};
export const useColors = () => new Proxy({}, { get: () => '#123456' });
export const useAuth = () => ({
  user: { id: 5, clientId: 23, name: 'Mobile Tester', role: 'client_staff' },
  // Entries may set window.patServices to model a client without PATtrack.
  hasService: (service) => (globalThis.patServices ?? ['pattrack']).includes(service),
});
export async function apiFetch(path, options = {}) {
  const response = await fetch(`https://pat-mobile.test${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-token', ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data;
}
