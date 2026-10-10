// Only native/device I/O is substituted. AuthProvider, apiFetch, IncidentScreen,
// React and TanStack Query are the production implementations.
import React from 'react';

const host = name => ({ children, onPress, value }) => React.createElement(
  name === 'TextInput' ? 'input' : name === 'TouchableOpacity' ? 'button' : 'div',
  name === 'TextInput' ? { value: value ?? '', readOnly: true } : { 'data-native': name, onClick: onPress },
  children,
);
export const View = host('View'), Text = host('Text'), ScrollView = host('ScrollView');
export const TouchableOpacity = host('TouchableOpacity'), TextInput = host('TextInput');
export const ActivityIndicator = host('ActivityIndicator'), Switch = host('Switch'), RefreshControl = host('RefreshControl');
export const Feather = () => null;
export const Platform = { OS: 'web' };
export const StyleSheet = { create: styles => styles };
export const Alert = { alert() {} };
export const useColorScheme = () => 'light';
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
export const useRouter = () => ({ back() {}, push() {}, replace() {} });
export const NotificationFeedbackType = { Success: 'success' };
export const notificationAsync = async () => {};

export const secureStore = new Map();
export const getItemAsync = async key => secureStore.get(key) ?? null;
export const setItemAsync = async (key, value) => { secureStore.set(key, value); };
export const deleteItemAsync = async key => { secureStore.delete(key); };
const listeners = new Set();
export const AppState = {
  addEventListener(_name, listener) { listeners.add(listener); return { remove() { listeners.delete(listener); } }; },
};
export const foreground = () => { for (const listener of listeners) listener('active'); };
export const kitchenOutbox = { updateToken() {}, suspend() {}, async activate() {} };
export const startKitchenReplay = () => () => {};
export const clearPendingIssueUploadRecovery = async () => {};
export const clearOtherPendingIssueUploadRecovery = async () => {};
export const registerForPushNotifications = async () => {};
export const unregisterPushToken = async () => {};
export const signInWithPasskey = async () => { throw new Error('Passkeys are not exercised by this fixture'); };
