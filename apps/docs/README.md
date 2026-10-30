# ScoutQA documentation

Independent, self-hostable documentation built with Astro 7 and Starlight. It provides 37 original guides and 24 generated tool pages across product, getting started, workspace, agents, API and operations sections. Public content is curated separately from the repository’s internal plans in [docs/](../../docs/README.md).

## Run with Docker

From the repository root:

~~~sh
docker compose -f compose.docs.yaml up -d --build --wait
~~~

Open http://127.0.0.1:18090. This service has no dependency on Scout’s API, databases, evidence or model credentials. It uses a read-only, unprivileged static Nginx container with pinned base-image digests. The build includes documentation tests.

For your own public domain, set DOCS_SITE_URL before building. Add DOCS_BASE_PATH for a subpath, for example /scout/. The server mounts files at that prefix. The origin must be HTTP(S), with no path/credentials/query/hash; the path is a separate setting.

~~~sh
DOCS_SITE_URL=https://docs.your-domain.tld \
  DOCS_BASE_PATH=/scout/ \
  docker compose -f compose.docs.yaml up -d --build --wait
~~~

Use your actual domain, DNS and TLS reverse proxy. The default loopback origin is noindex. Public origins default to indexable; set DOCS_INDEXABLE=false for staging. This is a build-time configuration: rebuild after changing it. No domain or external hosting is configured automatically.

Stop only the docs:

~~~sh
docker compose -f compose.docs.yaml down
~~~

## Develop with Node 24

Use the Node version in .nvmrc. The product’s API remains Rust; Node is a documentation build tool and is not present in the serving container.

~~~sh
npm ci --prefix apps/docs
npm run dev --prefix apps/docs
~~~

Production preview, with the full Pagefind search index:

~~~sh
npm run build --prefix apps/docs
npm run preview --prefix apps/docs
~~~

Preview runs at http://127.0.0.1:4321. Theme, search and copy controls use small client scripts; page text, navigation, metadata and machine exports do not require JavaScript. No remote fonts, analytics or hosted search are configured. Astro telemetry is disabled by the local command wrapper and Docker build.

Dependencies are pinned in package-lock.json. js-yaml 4 is an explicit runtime dependency because Starlight’s default-import parser must resolve independently of the OpenAPI validator’s YAML 5 dependency during Astro’s prerender bundling.

## Content and generated resources

Author Markdown under src/content/docs. Frontmatter uses JSON inside YAML delimiters, with title, description, reviewed (YYYY-MM-DD) and sidebar order. JSON frontmatter makes one parser sufficient for both Astro and machine exports. English is the current content language.

The prepare script generates these from the same pages and the committed Rust catalog snapshot:

- Every page’s index.md, advertised by an HTML Markdown alternate.
- llms.txt, llms-full.txt and docs-index.json.
- openapi.json (OpenAPI 3.1), mcp-tools.json and twenty-four tool-reference pages.
- A three-file ScoutQA skill, downloadable ZIP, SHA-256 checksum and package manifest.
- robots.txt. Astro builds the sitemap and Pagefind index.

Generated public files and tool pages are ignored by Git and recreated during dev/build/check. The reviewed Rust catalog is committed at src/data/mcp-tools.json.

After editing apps/api/src/agent.rs, refresh it from the repository root:

~~~sh
just docs-sync-api
~~~

This pure Rust example exports schemas without a database, live API, credentials or model calls. If the tool count changes, review the guide index and generator/test scope as part of that interface change.

## Verify

~~~sh
just docs-build
just docs-test
npm run test:deployments --prefix apps/docs
~~~

docs-test requires Rust for compiled catalog drift checks and compares all 42 documented operations against the Axum router. The standalone Docker build consumes the committed snapshot and requires no Rust toolchain or parent-repository access.

The nine build checks cover deployment URL validation; static headings/metadata/JSON-LD; all local navigation/assets/anchors; clean Markdown and LLM links; exact catalog correspondence; skill packaging/checksums/tool-name correspondence; OpenAPI validation and async contracts; robots/sitemap/search output; and exclusion of private paths/secrets/evidence.

The canonical instruction-only skill lives in skills/scout-qa, with its allowlist/version in skills/manifest.json. No client permission grants or executable hooks are bundled. The repository installer uses Python 3.9+ standard library only:

~~~sh
python3 scripts/install-scout-skill.py --client codex
python3 scripts/install-scout-skill.py --client claude --project /path/to/app
just skill-test
~~~

Run those commands from the repository root. The installer is a local file copier, not an MCP configurator. It preserves conflicting destinations and performs no provider calls. The standard-library installation tests also read the deterministic ZIP using Python's independent zipfile implementation. Skill downloads are regenerated from the same source for root and subpath deployments.

test:deployments repeats the production checks at a public root and /scout/ prefix, without publishing either. Its example.test origin is only a build fixture. Test output lives in ignored .cache directories; it restores ordinary generated public assets afterward.

To verify a running container’s HTTP status, MIME types, contracts and 404 behavior:

~~~sh
node apps/docs/scripts/verify-http.mjs http://127.0.0.1:18090/
~~~

## Contract scope and editorial rules

OpenAPI covers the public integration routes listed in it. Strict command bodies and report/progress fields are described; raw stored projections intentionally allow additional properties. Private human-login control, human review mutations and MCP JSON-RPC transport are not modeled as REST agent operations. The generated tool schemas are exact; cross-field runtime constraints are also documented.

Write about implemented behavior; mark missing features and live-model quality limits. Keep app observations separate from human confirmation. Do not publish credentials, private fixture recordings, personal machine paths or internal planning estimates. Maintain page review dates when reviewing substantive changes.

The SEO/GEO foundation is useful static content, internal links, canonical URLs, unique metadata, matching TechArticle/BreadcrumbList structured data, sitemap/robots and accessible machine exports. No ranking, AI citation or geographic reach is guaranteed.

The Astro and Starlight tooling is MIT licensed. This documentation setup does not assign a new license to Scout’s product code.
