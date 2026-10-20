import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";
// @ts-expect-error plain .mjs module without type declarations
import { resolveBaseUrl, assertCanonicalForProduction } from "./scripts/site-url.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { publicPages, renderPublicPageHtml } from "./scripts/seo-pages.mjs";

// Injects the canonical site URL into index.html (canonical link, Open Graph,
// Twitter, JSON-LD) at dev-serve and build time via the __SITE_URL__ placeholder.
function siteUrlHtmlPlugin() {
  return {
    name: "site-url-html",
    transformIndexHtml(html: string) {
      const { baseUrl, source } = resolveBaseUrl();
      assertCanonicalForProduction(baseUrl, source);
      return html.replaceAll("__SITE_URL__", baseUrl);
    },
  };
}

// Writes <path>/index.html for each public page other than the home page, so
// crawlers get that page's own title, description and canonical URL rather
// than the home page's. See scripts/seo-pages.mjs.
function publicPagesHtmlPlugin() {
  return {
    name: "public-pages-html",
    apply: "build" as const,
    writeBundle(options: { dir?: string }) {
      if (!options.dir) return;
      const indexHtml = fs.readFileSync(path.join(options.dir, "index.html"), "utf8");
      const { baseUrl } = resolveBaseUrl();
      for (const page of publicPages as Array<{ path: string; title?: string }>) {
        if (page.path === "/") continue;
        const pageDir = path.join(options.dir, page.path);
        fs.mkdirSync(pageDir, { recursive: true });
        fs.writeFileSync(path.join(pageDir, "index.html"), renderPublicPageHtml(indexHtml, page, baseUrl));
      }
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
    siteUrlHtmlPlugin(),
    publicPagesHtmlPlugin(),
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
