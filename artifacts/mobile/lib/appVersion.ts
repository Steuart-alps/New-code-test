import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * "1.0.0 (build 3)" from the app config the binary was built with
 * (app.json `version` plus ios.buildNumber / android.versionCode). eas.json
 * uses the local version source, so these match the store build numbers.
 */
export function appVersionLabel(): string {
  const config = Constants.expoConfig;
  const version = config?.version ?? '—';
  const build = Platform.OS === 'ios'
    ? config?.ios?.buildNumber
    : Platform.OS === 'android' && config?.android?.versionCode != null
      ? String(config.android.versionCode)
      : undefined;
  return build ? `${version} (build ${build})` : version;
}
