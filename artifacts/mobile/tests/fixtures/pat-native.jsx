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
export const View = host('div'), Text = host('span'), TouchableOpacity = host('button');
export const ActivityIndicator = () => React.createElement('span', null, 'Loading');
export const RefreshControl = () => null;
export const TextInput = ({ value, onChangeText, placeholder, testID }) => React.createElement('input', {
  ...testProps(testID), value: value ?? '', placeholder, onChange: (event) => onChangeText?.(event.target.value),
});
export const Modal = ({ visible, children }) => (visible ? React.createElement('div', { 'data-testid': 'native-modal' }, children) : null);
export const KeyboardAwareScrollViewCompat = ({ children }) => React.createElement('div', null, children);
export const Feather = () => null;
export const Platform = { OS: 'web' };
export const StyleSheet = { create: (styles) => styles, absoluteFill: {} };
export const alerts = [];
export const Alert = { alert(title, message) { alerts.push({ title, message }); } };
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
export const useRouter = () => ({ back() {}, push() {}, replace() {} });
export const NotificationFeedbackType = { Success: 'success', Error: 'error', Warning: 'warning' };
export const notificationAsync = async () => {};
export const useColors = () => new Proxy({}, { get: () => '#123456' });
export const useAuth = () => ({
  user: { id: 5, clientId: 23, name: 'Mobile Tester', role: 'client_staff' },
  hasService: (service) => service === 'pattrack',
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

// Camera and permission stand-ins for the asset tag scanner. The Playwright
// test drives them through window.cameraHarness: setPermission() changes what
// the permission hook reports, scan() delivers a barcode to the mounted
// CameraView the way the native scanner would.
const camera = {
  permission: { granted: true, canAskAgain: true, status: 'granted' },
  requestResult: null,
  requests: 0,
  openedSettings: 0,
  listeners: new Set(),
  onBarcodeScanned: null,
  mounted: false,
};
const notifyCamera = () => camera.listeners.forEach((listener) => listener());
if (typeof window !== 'undefined') {
  window.cameraHarness = {
    setPermission(permission) { camera.permission = permission; notifyCamera(); },
    setRequestResult(result) { camera.requestResult = result; },
    setPlatform(os) { Platform.OS = os; },
    scan(data) {
      if (!camera.onBarcodeScanned) return false;
      camera.onBarcodeScanned({ type: 'qr', data });
      return true;
    },
    get mounted() { return camera.mounted; },
    get scanning() { return !!camera.onBarcodeScanned; },
    get requests() { return camera.requests; },
    get openedSettings() { return camera.openedSettings; },
  };
}
export function useCameraPermissions() {
  const permission = React.useSyncExternalStore(
    (listener) => { camera.listeners.add(listener); return () => camera.listeners.delete(listener); },
    () => camera.permission,
  );
  const request = React.useCallback(async () => {
    camera.requests += 1;
    if (camera.requestResult) { camera.permission = camera.requestResult; notifyCamera(); }
    return camera.permission;
  }, []);
  const get = React.useCallback(async () => camera.permission, []);
  return [permission, request, get];
}
export function CameraView({ testID, onBarcodeScanned }) {
  React.useEffect(() => {
    camera.mounted = true;
    return () => { camera.mounted = false; camera.onBarcodeScanned = null; };
  }, []);
  camera.onBarcodeScanned = onBarcodeScanned ?? null;
  return React.createElement('div', testProps(testID));
}
export const Linking = { async openSettings() { camera.openedSettings += 1; } };
export const AppState = { addEventListener: () => ({ remove() {} }) };
