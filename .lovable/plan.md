# Fix AI-visibility blocker: parseable JSON-LD on public pages

## What the audit found (verified)

I fetched the live site. Every public route returns the same stale static HTML:

- `https://www.onepointsix.ai/` → `<title>EasyVC</title>`, no JSON-LD
- `/intake`, `/login`, `/docs/mcp` → identical, no JSON-LD, no canonical

The repo's `index.html` already contains `SoftwareApplication` + `Organization` JSON-LD and the better title/description — but the **deployed** build is older. On top of that, no route emits page-specific JSON-LD (Article/Breadcrumb/etc.), so even after republish only the sitewide schema would be visible.

## Plan

### 1. Republish (immediate win)

Re-publish from current `main` so the live HTML picks up the existing `index.html`:
- `<title>EasyVC — Autonomous OS for VC Analysts`
- `meta description`, `canonical`, OG/Twitter
- `SoftwareApplication` + `Organization` JSON-LD

This alone fixes the "no parseable JSON-LD in raw HTML" blocker on `/` for crawlers that read static HTML.

### 2. Add per-route head + JSON-LD on public pages

Install `react-helmet-async`, wrap `<App>` in `<HelmetProvider>` in `src/main.tsx`, then add `<Helmet>` blocks to the three public pages:

| Route | Title | JSON-LD |
|---|---|---|
| `/` (workspace landing / login redirect) | EasyVC — Autonomous OS for VC Analysts | keep sitewide `SoftwareApplication` + `Organization` in `index.html` |
| `/intake` (`PublicIntake.tsx`) | Submit your deal to EasyVC | `WebPage` + `BreadcrumbList` (Home → Intake) |
| `/login` (`LoginPage.tsx`) | Sign in — EasyVC | `WebPage` + `BreadcrumbList` |
| `/docs/mcp` (if it exists as a public route) | EasyVC MCP Server — Docs | `TechArticle` + `BreadcrumbList` |

Each Helmet block also sets a self-referencing `canonical` and `og:url` (per head-meta rules), and removes the sitewide `<link rel="canonical">` from `index.html` so per-route canonicals don't conflict.

Sitewide `og:*` stays in `index.html` as the fallback for non-JS social crawlers.

### 3. Verify

- After republish: `curl -sL https://www.onepointsix.ai/ | grep ld+json` should return the schema blocks.
- Run the SEO scanner (`seo_chat--trigger_scan`) to confirm the JSON-LD finding clears.
- Note to user: Helmet mutates `document.head` client-side, so JS-executing crawlers (Googlebot, ChatGPT browser) see per-route JSON-LD, but pure-HTML scrapers only see the sitewide schema. That's acceptable for this fix; full per-route static rendering would require SSR.

### Out of scope

- No backend / edge-function changes.
- No design changes.
- No OpenAI key / process-deck work (separate thread).

## Technical notes

- `react-helmet-async` chosen over alternatives because it's the convention already referenced in project knowledge and supports the existing Vite + React 18 stack.
- `Organization.sameAs` could later include LinkedIn / X handles once provided — leave the array as-is for now.
- `BreadcrumbList` items use absolute `https://www.onepointsix.ai/...` URLs to match `canonical`.
