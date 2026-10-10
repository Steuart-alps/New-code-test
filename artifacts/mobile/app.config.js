// Extends app.json (passed in as `config`) with values that differ per build.
//
// Native passkeys need the app's identifiers and the API domain to match what
// the API publishes in /.well-known/apple-app-site-association and
// /.well-known/assetlinks.json, so they come from the same environment
// variables (see .env.example). Expo Go ignores all of this.
function hostOf(value) {
  const trimmed = value.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).hostname;
}

module.exports = ({ config }) => {
  const domain = process.env.EXPO_PUBLIC_DOMAIN ? hostOf(process.env.EXPO_PUBLIC_DOMAIN) : null;
  const iosBundleId = process.env.MOBILE_IOS_BUNDLE_ID?.trim();
  const androidPackage = process.env.MOBILE_ANDROID_PACKAGE?.trim();

  return {
    ...config,
    ios: {
      ...config.ios,
      ...(iosBundleId ? { bundleIdentifier: iosBundleId } : {}),
      ...(domain
        ? { associatedDomains: [...(config.ios?.associatedDomains ?? []), `webcredentials:${domain}`] }
        : {}),
    },
    android: {
      ...config.android,
      ...(androidPackage ? { package: androidPackage } : {}),
    },
  };
};
