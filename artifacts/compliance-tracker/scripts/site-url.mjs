// Shared canonical base URL resolution for SEO artifacts.
//
// Resolution order:
//   1. PUBLIC_SITE_URL            (set this once you have a custom domain)
//   2. PUBLIC_APP_URL             (the app's public address)
//   3. local dev fallback
export function resolveBaseUrl() {
  if (process.env.PUBLIC_SITE_URL) {
    return {
      baseUrl: process.env.PUBLIC_SITE_URL.replace(/\/+$/, ""),
      source: "PUBLIC_SITE_URL",
    };
  }
  if (process.env.PUBLIC_APP_URL) {
    return {
      baseUrl: process.env.PUBLIC_APP_URL.replace(/\/+$/, ""),
      source: "PUBLIC_APP_URL",
    };
  }
  return { baseUrl: "http://localhost:21186", source: "localhost-fallback" };
}

// Never ship a production build with a non-canonical (localhost) host.
export function assertCanonicalForProduction(source) {
  if (source === "localhost-fallback" && process.env.NODE_ENV === "production") {
    throw new Error(
      "[seo] No canonical site URL available for production build. " +
        "Set PUBLIC_SITE_URL (custom domain) or PUBLIC_APP_URL.",
    );
  }
}
