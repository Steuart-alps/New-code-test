---
name: SEO static files (robots/sitemap/llms)
description: How robots.txt, sitemap.xml and llms.txt are produced and served for the compliance-tracker SPA.
---

# SEO static files for the public site

robots.txt, sitemap.xml and llms.txt for the `compliance-tracker` artifact are **generated at build time**, not hand-written. The generator is `artifacts/compliance-tracker/scripts/generate-seo.mjs`, wired into both the `dev` and `build` npm scripts so files always exist.

**Why generated:** canonical URLs are environment-specific. The generator resolves the base URL in order: `PUBLIC_SITE_URL` (set once a custom domain exists) → `RENDER_EXTERNAL_URL` → the verified production domain (`scripts/site-url.mjs`). A production build (`NODE_ENV=production`) **throws** on a non-HTTPS or localhost canonical URL, so a deploy can never publish broken canonical URLs.

**Why gitignored:** the three output files (`public/robots.txt`, `public/sitemap.xml`, `public/llms.txt`) are in `artifacts/compliance-tracker/.gitignore` because they contain the env-specific host and are regenerated on every dev start and build.

**How to apply:**
- Public pages are listed once in `scripts/seo-pages.mjs` (`publicPages`): it feeds sitemap.xml, and a Vite build plugin (`vite.config.ts`) copies the built index.html to `<path>/index.html` for each non-home page with that page's title, description, canonical, social tags and a short static body. Add a public page there, never by hand-editing the gitignored output files (they get overwritten). `tests/seo-pages.test.mjs` (run after a build, also in CI) checks the output.
- To change which app routes crawlers avoid, edit the `privatePaths` array. Indexable routes are exactly the `publicPages` paths; everything else is behind auth or a token link.
- Serving works because the API's static web handler (`api-server/src/app.ts`, `WEB_DIST_DIR`) serves real files in `dist/public` first (with `redirect: false`, so `/signup` is not bounced to `/signup/`), then a prerendered `<path>/index.html` for public pages, and otherwise falls back to `index.html` with `X-Robots-Tag: noindex` so app, token and unknown URLs are never indexed as copies of the home page. (Before 2026-10-09 the Replit static deploy rewrite in `.replit-artifact/artifact.toml` did this.)
