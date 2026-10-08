import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
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

const rawPort = process.env.WEB_PORT ?? "5173";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid WEB_PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

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
    siteUrlHtmlPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
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
    // The API runs as a separate process in development; in production it
    // serves this build itself, so /api is always same-origin.
    proxy: {
      "/api": `http://localhost:${process.env.API_PORT ?? "8080"}`,
    },
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
