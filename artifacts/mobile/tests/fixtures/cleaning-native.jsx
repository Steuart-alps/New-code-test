// Only native/device I/O and app plumbing are substituted. CleaningScreen, the
// cleaning draft logic, OutboxEntries, useRecordOutbox, the CheckOutbox core,
// React and TanStack Query are the production implementations; apiFetch
// performs real HTTP requests that the Playwright test answers with
// API-shaped fixtures.
import React from 'react';

const testProps = (testID) => (testID ? { 'data-testid': testID } : {});
const a11yProps = (role, state) => ({
  ...(role ? { role: role === 'checkbox' ? 'checkbox' : undefined } : {}),
  ...(state && 'checked' in state ? { 'aria-checked': String(!!state.checked) } : {}),
});
const host = (tag) => ({ children, onPress, testID, disabled, accessibilityRole, accessibilityState }) => React.createElement(
  tag,
  {
    ...testProps(testID),
    ...a11yProps(accessibilityRole, accessibilityState),
    ...(onPress ? { onClick: onPress } : {}),
    ...(tag === 'button' ? { disabled: !!disabled, type: 'button' } : {}),
  },
  children,
);
export const View = host('div'), Text = host('span'), TouchableOpacity = host('button'), ScrollView = host('div');
export const ActivityIndicator = () => React.createElement('span', null, 'Loading');
export const RefreshControl = () => null;
export const TextInput = ({ value, onChangeText, placeholder, testID, editable }) => React.createElement('input', {
  ...testProps(testID), value: value ?? '', placeholder, disabled: editable === false,
  onChange: (event) => onChangeText?.(event.target.value),
});
export const KeyboardAwareScrollViewCompat = ({ children }) => React.createElement('div', null, children);
export const Feather = () => null;
export const Platform = { OS: 'web' };
export const StyleSheet = { create: (styles) => styles };
// Alerts are recorded with their buttons; the test presses one by its label.
export const alerts = [];
export const Alert = { alert(title, message, buttons) { alerts.push({ title, message, buttons: buttons ?? [] }); } };
export function pressAlertButton(text) {
  const alert = alerts.at(-1);
  const button = alert?.buttons.find((candidate) => candidate.text === text);
  if (!button) throw new Error(`No "${text}" button on the latest alert (${alert?.title})`);
  alerts.push({ title: `pressed:${text}`, message: alert.title, buttons: [] });
  button.onPress?.();
}
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
export const useRouter = () => ({ back() {}, push() {}, replace() {} });
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
export const notificationAsync = async () => {};
export const useColors = () => new Proxy({}, { get: () => '#123456' });
export const fixtureUser = { id: 5, clientId: 23, name: 'Mobile Tester', role: 'client_staff' };
export const useAuth = () => ({
  user: fixtureUser,
  hasService: (service) => service === 'kitchentrack',
});
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
export async function apiFetch(path, options = {}) {
  const response = await fetch(`https://cleaning-mobile.test${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-token', ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  // Like lib/api.ts ApiError: the status tells the outbox a rejection from a lost connection.
  if (!response.ok) throw new ApiError(data?.error ?? `Request failed (${response.status})`, response.status);
  return data;
}

// @react-native-async-storage/async-storage: device storage that outlives a
// remount of the screen (an app restart), held in memory for the page.
export const deviceStorage = new Map();
const AsyncStorage = {
  async getItem(key) { return deviceStorage.get(key) ?? null; },
  async setItem(key, value) { deviceStorage.set(key, value); },
  async removeItem(key) { deviceStorage.delete(key); },
};
export default AsyncStorage;
