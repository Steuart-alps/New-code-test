// Shared canonical base URL resolution for SEO artifacts.
//
// Resolution order:
//   1. PUBLIC_SITE_URL            (set this once you have a custom domain)
//   2. Render's deployment URL when running on Render
//   3. the verified production custom domain
// REPLIT_DOMAINS is intentionally ignored because it is a temporary .replit.dev
// address in workspace builds, not the public canonical URL.
const PRODUCTION_SITE_URL = "https://complytrack.alpsconsultancy.co.uk";
export function resolveBaseUrl() {
  if (process.env.PUBLIC_SITE_URL) {
    return {
      baseUrl: process.env.PUBLIC_SITE_URL.replace(/\/+$/, ""),
      source: "PUBLIC_SITE_URL",
    };
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return {
      baseUrl: process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, ""),
      source: "RENDER_EXTERNAL_URL",
    };
  }
  return { baseUrl: PRODUCTION_SITE_URL, source: "verified-production-url" };
}

// Never ship a production build with a non-canonical (localhost) host.
export function assertCanonicalForProduction(baseUrl, source) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`[seo] Invalid canonical site URL from ${source}: ${baseUrl}`);
  }
  const unsafeHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    || url.hostname.endsWith(".replit.dev");
  if (process.env.NODE_ENV === "production" && (url.protocol !== "https:" || unsafeHost)) {
    throw new Error(
      `[seo] Production canonical URL must be a public HTTPS address, received ${baseUrl} from ${source}.`,
    );
  }
}
