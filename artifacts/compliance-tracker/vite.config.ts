import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
// @ts-expect-error plain .mjs module without type declarations
import { resolveBaseUrl, assertCanonicalForProduction } from "./scripts/site-url.mjs";

// Injects the canonical site URL into index.html (canonical link, Open Graph,
// Twitter, JSON-LD) at dev-serve and build time via the __SITE_URL__ placeholder.
function siteUrlHtmlPlugin() {
  return {
    name: "site-url-html",
    transformIndexHtml(html: string) {
      const { baseUrl, source } = resolveBaseUrl();
      assertCanonicalForProduction(source);
      return html.replaceAll("__SITE_URL__", baseUrl);
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  // Forward the server-side SENTRY_DSN secret to the client bundle under the
  // VITE_ prefix.  The Sentry DSN is intentionally public (it's designed to
  // be embedded in client code) so this is safe.
  define: {
    "import.meta.env.VITE_SENTRY_DSN": JSON.stringify(process.env.SENTRY_DSN ?? ""),
  },
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    siteUrlHtmlPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
