// Generates robots.txt, sitemap.xml and llms.txt into the public/ directory.
// Run automatically before `vite build` (and on demand for local dev).
//
// Canonical base URL resolution order:
//   1. PUBLIC_SITE_URL            (set this once you have a custom domain)
//   2. https://<first REPLIT_DOMAINS entry>   (the deployment's own address)
//   3. local dev fallback
//
// Because it reads the domain at build time, the production deployment build
// emits files pointing at the live published address automatically.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBaseUrl, assertCanonicalForProduction } from "./site-url.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const { baseUrl, source } = resolveBaseUrl();

// Never ship a production build with a non-canonical (localhost) host — that would
// publish broken sitemap/llms URLs. Fail loudly so the deployment is corrected.
assertCanonicalForProduction(source);
const today = new Date().toISOString().slice(0, 10);

// Public, indexable pages. Everything else is behind auth.
const publicPages = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/signup", changefreq: "monthly", priority: "0.8" },
  { path: "/login", changefreq: "monthly", priority: "0.5" },
  { path: "/terms", changefreq: "yearly", priority: "0.3" },
  { path: "/privacy", changefreq: "yearly", priority: "0.3" },
];

// Authenticated app sections — keep crawlers out (they only get the SPA shell).
const privatePaths = [
  "/dashboard",
  "/contractors",
  "/external",
  "/external-checks",
  "/items",
  "/sites",
  "/categories",
  "/users",
  "/settings",
  "/clients",
  "/reset-password",
  "/schedule",
];

const robotsTxt = `# robots.txt for ComplyTrack
User-agent: *
${privatePaths.map((p) => `Disallow: ${p}`).join("\n")}
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
`;

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${publicPages
  .map((page) => {
    const loc = `${baseUrl}${page.path}`;
    return `  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`;
  })
  .join("\n")}
</urlset>
`;

const llmsTxt = `# ComplyTrack

> Health & Safety compliance tracking for businesses worldwide. ComplyTrack helps companies stay on top of their statutory H&S obligations across one site or many — tracking compliance checks, storing certificates, managing contractors, and sending automated reminders before things fall due.

ComplyTrack is a multi-tenant SaaS platform for businesses anywhere in the world managing their own Health & Safety compliance. Each business's data is fully isolated. Businesses can optionally invite their external H&S consultant in with scoped access. Pricing is per site (per building) on a simple monthly subscription.

## Primary pages
- [Home](${baseUrl}/): What ComplyTrack does, who it serves, and key features.
- [Sign up](${baseUrl}/signup): Create an account and start tracking compliance.
- [Log in](${baseUrl}/login): Access for existing customers.

## Notes for AI crawlers
- The home page is the canonical reference for what the product is and who it serves.
- All other application routes (dashboard, sites, contractors, settings, etc.) sit behind authentication and are not part of the public, indexable surface.
- For the most accurate, current information about features and pricing, use the home page.
`;

mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, "robots.txt"), robotsTxt, "utf8");
writeFileSync(join(publicDir, "sitemap.xml"), sitemapXml, "utf8");
writeFileSync(join(publicDir, "llms.txt"), llmsTxt, "utf8");

console.log(`[generate-seo] wrote robots.txt, sitemap.xml, llms.txt using base URL: ${baseUrl} (source: ${source})`);
