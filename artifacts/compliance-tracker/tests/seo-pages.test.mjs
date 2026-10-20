// Checks the built web app gives each public page its own crawlable HTML.
// Run after `pnpm --filter @workspace/compliance-tracker run build`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicPages } from "../scripts/seo-pages.mjs";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "public");
assert.ok(existsSync(join(distDir, "index.html")), "Build the web app before running this test");

const indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
const baseUrl = indexHtml.match(/<link rel="canonical" href="([^"]*)\/"/)?.[1];
assert.ok(baseUrl?.startsWith("http"), "index.html should carry an absolute canonical URL for the home page");
const appScript = indexHtml.match(/<script type="module"[^>]*src="[^"]*"[^>]*>/)?.[0];
assert.ok(appScript, "index.html should load the app bundle");

const count = (html, pattern) => (html.match(new RegExp(pattern.source, "g")) ?? []).length;
const sitemap = readFileSync(join(distDir, "sitemap.xml"), "utf8");

for (const page of publicPages) {
  const url = `${baseUrl}${page.path}`;
  assert.ok(sitemap.includes(`<loc>${url}</loc>`), `sitemap.xml should list ${url}`);
  if (page.path === "/") continue;

  const file = join(distDir, page.path, "index.html");
  assert.ok(existsSync(file), `${page.path} should be prerendered`);
  const html = readFileSync(file, "utf8");
  const title = page.title.replaceAll("&", "&amp;");

  assert.equal(count(html, /<link rel="canonical"/), 1, `${page.path} should have one canonical link`);
  assert.ok(html.includes(`<link rel="canonical" href="${url}" />`), `${page.path} canonical should be its own URL`);
  assert.ok(html.includes(`<meta property="og:url" content="${url}" />`), `${page.path} og:url should be its own URL`);
  assert.ok(html.includes(`<title>${title}</title>`), `${page.path} should have its own title`);
  assert.ok(html.includes(`<meta property="og:title" content="${title}" />`), `${page.path} should have its own og:title`);
  assert.equal(count(html, /<title>/), 1, `${page.path} should have one title`);
  assert.equal(count(html, /<h1>/), 1, `${page.path} should have one h1`);
  assert.ok(html.includes(`<h1>${page.heading}</h1>`), `${page.path} should show its own heading before JavaScript runs`);
  assert.ok(!html.includes("Everything you need to stay compliant"), `${page.path} should not repeat the home page body`);
  assert.ok(html.includes(appScript), `${page.path} should load the same app bundle as the home page`);
  assert.ok(html.includes('"@type": "SoftwareApplication"'), `${page.path} should keep the site's structured data`);
}

console.log(`seo-pages: ${publicPages.length} public pages OK (${baseUrl})`);
