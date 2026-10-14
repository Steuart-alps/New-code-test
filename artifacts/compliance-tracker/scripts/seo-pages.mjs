// The public, indexable pages of the web app and what search engines see for
// each one before JavaScript runs.
//
// The SPA ships a single index.html (the home page). At build time
// vite.config.ts copies it to <path>/index.html for every other page here,
// swapping in that page's title, description, canonical URL, social preview
// text and a short static body, so /signup is not read as a copy of /. The API
// serves those files and marks every other non-API route noindex (see
// api-server src/app.ts). generate-seo.mjs builds sitemap.xml from this list.

export const publicPages = [
  {
    path: "/",
    sitemap: { changefreq: "weekly", priority: "1.0" },
  },
  {
    path: "/signup",
    title: "Start a Free Trial | ComplyTrack Health & Safety Software",
    description:
      "Create a ComplyTrack account and start a 14-day free trial of UK health and safety compliance software for one site or many.",
    heading: "Start your free trial",
    body: [
      "Create a ComplyTrack account to manage health and safety records, contractor certificates and reminders across one site or many.",
      "Every new business gets a 14-day free trial.",
    ],
    sitemap: { changefreq: "monthly", priority: "0.8" },
  },
  {
    path: "/login",
    title: "Sign In | ComplyTrack",
    description: "Sign in to your ComplyTrack account to manage your health and safety compliance records.",
    heading: "Sign in to ComplyTrack",
    body: ["Sign in to manage your health and safety compliance records."],
    sitemap: { changefreq: "monthly", priority: "0.5" },
  },
  {
    path: "/terms",
    title: "Terms of Service | ComplyTrack",
    description: "The terms that apply when you create a ComplyTrack account or use the ComplyTrack service.",
    heading: "Terms of Service",
    body: ["The terms that apply when you create a ComplyTrack account or use the ComplyTrack service."],
    sitemap: { changefreq: "yearly", priority: "0.3" },
  },
  {
    path: "/privacy",
    title: "Privacy Policy | ComplyTrack",
    description: "How ComplyTrack collects, uses and protects personal data.",
    heading: "Privacy Policy",
    body: ["How ComplyTrack collects, uses and protects personal data."],
    sitemap: { changefreq: "yearly", priority: "0.3" },
  },
];

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Replaces exactly one match of `pattern` in `html`, or throws so a change to
// index.html that breaks the swap fails the build instead of shipping pages
// that all claim to be the home page.
function replaceOnce(html, pattern, replacement, what) {
  const matches = html.match(new RegExp(pattern.source, "g")) ?? [];
  if (matches.length !== 1) {
    throw new Error(`[seo-pages] expected one ${what} in index.html, found ${matches.length}`);
  }
  // A function replacement keeps "$" in page text from being read as a pattern.
  return html.replace(pattern, typeof replacement === "function" ? replacement : () => replacement);
}

function metaPattern(attr, key) {
  return new RegExp(`<meta\\s+${attr}="${key}"\\s+content="[^"]*"\\s*\\/?>`);
}

// Builds a public page's HTML from the built home page (index.html).
export function renderPublicPageHtml(indexHtml, page, baseUrl) {
  const url = `${baseUrl}${page.path}`;
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);

  let html = indexHtml;
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`, "<title>");
  html = replaceOnce(html, /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${url}" />`, "canonical link");
  for (const [attr, key, value] of [
    ["name", "description", description],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", url],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
  ]) {
    html = replaceOnce(html, metaPattern(attr, key), `<meta ${attr}="${key}" content="${value}" />`, `${key} meta tag`);
  }

  const body = [
    `<p><a href="/"><strong>ComplyTrack</strong></a></p>`,
    `<h1>${escapeHtml(page.heading)}</h1>`,
    ...page.body.map((text) => `<p>${escapeHtml(text)}</p>`),
    `<p><a href="/">ComplyTrack home</a> · <a href="/signup">Start your free trial</a> · <a href="/login">Sign in</a></p>`,
  ].join("\n        ");
  html = replaceOnce(
    html,
    /<div id="root">[\s\S]*<\/div>(\s*<\/body>)/,
    (_match, bodyClose) => `<div id="root">
      <div style="font-family: Inter, system-ui, sans-serif; max-width: 56rem; margin: 0 auto; padding: 3rem 1.5rem; line-height: 1.6; color: #1a202c;">
        ${body}
      </div>
    </div>${bodyClose}`,
    "#root element",
  );
  return html;
}
