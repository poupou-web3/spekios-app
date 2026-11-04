---
{
  "title": "Self-host these docs",
  "description": "Build and deploy Spekios documentation as static HTML with Astro Starlight, local search, Markdown exports, OpenAPI, sitemap and Docker.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 5
  }
}
---
These docs are an independent Astro Starlight app in **apps/docs**. The output is static HTML, local search assets, Markdown and JSON contracts. You can serve it on your own machine or static infrastructure without a paid documentation platform.

## Build and preview with Node

Use Node 24, then run from the repository root:

~~~sh
npm ci --prefix apps/docs
npm run build --prefix apps/docs
npm run preview --prefix apps/docs -- --host 127.0.0.1
~~~

Open **http://127.0.0.1:4321**. Built-in search is generated during the production build. Development mode explains that search is available after a build.

The default origin is localhost and the default robots policy is **noindex, nofollow**.

## Set your public origin before building

Canonical URLs, machine-document links, Open Graph metadata and sitemap URLs are fixed at build time. Set the actual deployment origin:

~~~sh
DOCS_SITE_URL=https://docs.your-domain.tld \
  npm run build --prefix apps/docs
~~~

Replace that example domain with your real origin. Serve **apps/docs/dist** with a static server. Do not upload the repository root.

For a subpath deployment, also set **DOCS_BASE_PATH=/scout/** and mount the output at that path. A build must use the same path as its server.

**DOCS_INDEXABLE=false** disables indexing for previews/staging. Non-loopback origins default to indexable; loopback origins cannot be explicitly made indexable. Public builds provide robots.txt and a sitemap index.

## Standalone Docker deployment

From the repository root:

~~~sh
docker compose -f compose.docs.yaml up -d --build
~~~

This starts only the docs on **http://127.0.0.1:18090**, with no dependency on the API, databases or provider secrets.

For a public build:

~~~sh
DOCS_SITE_URL=https://docs.your-domain.tld \
  docker compose -f compose.docs.yaml up -d --build
~~~

Put your own TLS reverse proxy in front of the loopback port. For a subpath, set **DOCS_BASE_PATH** at the same time. The container serves its files at that configured prefix.

Stop only this independent service with:

~~~sh
docker compose -f compose.docs.yaml down
~~~

No data volumes are attached to it. The static build includes no private environment files, evidence or model credentials.

## Edit and verify

Author Markdown in **apps/docs/src/content/docs**. Each page has a title, description, review date and sidebar order. Update the review date when reviewing that page’s substance.

After changing Rust tool definitions, run:

~~~sh
just docs-sync-api
just docs-build
just docs-test
~~~

The catalog snapshot is generated without starting services or making model calls. Tool pages, per-page Markdown, llms files and the docs index are regenerated during the build.

Checks validate contracts, internal links, metadata, machine exports and deployment paths. See **apps/docs/README.md** for the developer commands and contract scope.

## SEO and generative-engine visibility

The site delivers useful page text in static HTML, stable headings, crawlable links, unique titles/descriptions, canonical URLs and matching structured data. Pagefind search runs locally. Each page offers a Markdown alternate.

These foundations make content accessible to crawlers and LLM consumers. No metadata, llms file or schema guarantees rankings or AI citations. This site does not invent geographic offices, reviews or customer claims.

The site tooling, Astro and Starlight, is MIT licensed. Hosting resources and domains remain your responsibility; this does not assign a new license to Spekios’s product code.

For the underlying guidance, see [Astro static deployment](https://docs.astro.build/en/guides/deploy/), [Starlight](https://starlight.astro.build/), [the llms.txt proposal](https://llmstxt.org/) and [Google’s AI search guidance](https://developers.google.com/search/docs/appearance/ai-features).
