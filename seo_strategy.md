# SEO Strategy

## In scope
- Public marketing landing page (`/`)
- Sitewide crawlability files and bot-facing endpoints (`/robots.txt`, `/sitemap.xml`, `/llms.txt`)
- Public unauthenticated utility routes only for major technical SEO issues (`/login`, `/signup`, `/reset-password`, `/schedule/:token`)

## Out of scope
- Authenticated dashboard and tenant routes (`/dashboard`, `/contractors`, `/external*`, `/items/:id`, `/sites*`, `/categories*`, `/users`, `/settings`, `/clients`)
- Internal API routes under `/api/**`

## Target audience
- UK businesses managing health and safety compliance across one site or multiple sites
- Operations, facilities, and compliance teams that need contractor, certificate, and reminder tracking

## Primary keywords
- Health and safety compliance software
- Compliance tracking software UK
- Contractor compliance management
- Multi-site compliance tracking

## Notes
- The public app is a Vite React SPA with a single shared HTML shell at `artifacts/compliance-tracker/index.html`.
- The main organic acquisition surface is the landing page at `/`.
- Public auth and tokenized utility pages are not primary ranking targets; scan them only for major crawlability or indexing risks.

## Dismissed categories
- None yet.
