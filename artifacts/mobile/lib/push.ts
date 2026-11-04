/**
 * Expo push notification registration + handling.
 *
 * - registerForPushNotifications(): requests permission, obtains the Expo push
 *   token, and registers it with the API. Returns the token (or null).
 * - unregisterPushToken(): tells the API to forget the current device's token
 *   (called on logout).
 *
 * All functions are best-effort: a failure to register a push token must
 * never break login/logout. Failures are logged with console.warn so a
 * misconfigured build is visible in device logs.
 *
 * Remote push needs an EAS project id (`extra.eas.projectId` in the app
 * config, added by `eas init` under the owner's Expo account). Without it,
 * registration is skipped with a single warning.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { apiFetch } from './api';

// Foreground notifications: show a banner/alert while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let lastRegisteredToken: string | null = null;
let warnedMissingProjectId = false;

/** Resolve the EAS/Expo project id needed for getExpoPushTokenAsync. */
function getProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as any)?.easConfig?.projectId ??
    undefined
  );
}

/**
 * Request permission, fetch the Expo push token, and register it with the API.
 * Push tokens are only available on physical devices — returns null on
 * simulators/web.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return null;
    if (!Device.isDevice) return null;

    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const projectId = getProjectId();
    if (!projectId) {
      if (!warnedMissingProjectId) {
        warnedMissingProjectId = true;
        console.warn(
          '[push] Push notifications are disabled: this build has no EAS project id '
          + '(expo.extra.eas.projectId). Run `eas init` to link the app to an Expo '
          + 'project, then rebuild.',
        );
      }
      return null;
    }
    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenResponse.data;
    if (!token) return null;

    await apiFetch('/api/mobile/push-token', {
      method: 'POST',
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
    lastRegisteredToken = token;
    return token;
  } catch (error) {
    // Best-effort — never let push registration break the app.
    console.warn(
      '[push] Could not register this device for push notifications:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Unregister the current device's push token with the API (best-effort). */
export async function unregisterPushToken(): Promise<void> {
  try {
    let token = lastRegisteredToken;
    const projectId = getProjectId();
    if (!token && projectId && Platform.OS !== 'web' && Device.isDevice) {
      const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
      token = tokenResponse.data ?? null;
    }
    if (!token) return;
    await apiFetch('/api/mobile/push-token', {
      method: 'DELETE',
      body: JSON.stringify({ token }),
    });
  } catch {
    // Best-effort.
  } finally {
    lastRegisteredToken = null;
  }
}
