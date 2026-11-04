# Spekios documentation site

The public, self-hostable documentation, built with Astro and Starlight into static files served by an unprivileged nginx container. It has no dependency on the Spekios API, databases, evidence or model credentials. The repository's internal engineering notes live separately in [docs/](../../docs/README.md).

## Run with Docker

From the repository root:

```sh
just docs-up      # docker compose -f compose.docs.yaml up -d --build --wait
just docs-down
```

Open http://127.0.0.1:18090. The image build (`apps/docs/Dockerfile`) runs the build and `npm test` before producing the serving image.

Build-time settings (rebuild after changing them):

- `DOCS_SITE_URL`: public origin, HTTP(S) with no path, credentials, query or hash. Default `http://localhost:18090`.
- `DOCS_BASE_PATH`: subpath to serve under, for example `/scout/`. Default `/`.
- `DOCS_INDEXABLE`: loopback origins are `noindex`; public origins are indexable unless this is `false` (use it for staging).

```sh
DOCS_SITE_URL=https://docs.your-domain.tld DOCS_BASE_PATH=/scout/ just docs-up
```

DNS, TLS and the reverse proxy are yours to provide.

## Develop

Requires Node.js 24 (`.nvmrc`). Node is only a build tool here; it is not in the serving container.

```sh
just docs-install   # npm ci --prefix apps/docs
just docs-dev       # dev server
just docs-build     # static build with the Pagefind search index
npm run preview --prefix apps/docs   # http://127.0.0.1:4321
```

Author pages as Markdown under `src/content/docs`. Frontmatter is JSON inside YAML delimiters, with `title`, `description`, `reviewed` (YYYY-MM-DD) and sidebar order.

`scripts/prepare.mjs` runs before dev, build and check, and generates (ignored by Git):

- a Markdown copy of every page, `llms.txt`, `llms-full.txt` and `docs-index.json`;
- `openapi.json`, `mcp-tools.json` and one reference page per agent tool;
- the downloadable `scout-qa` skill package (ZIP, checksum, manifest) from `skills/`;
- `robots.txt`. Astro builds the sitemap and search index.

The tool pages and `mcp-tools.json` come from the committed snapshot `src/data/mcp-tools.json`, so the Docker build needs no Rust. After changing the agent tools in `apps/api/src/agent/catalog.rs`, refresh the snapshot from the repository root:

```sh
just docs-sync-api   # runs apps/api/examples/export_agent_catalog.rs; no database or API
```

## Test

```sh
just docs-build
just docs-test                                   # astro check, node tests, API contract check
npm run test:deployments --prefix apps/docs      # repeat the build checks at / and /scout/
node apps/docs/scripts/verify-http.mjs http://127.0.0.1:18090/   # a running container
```

`npm test` reads `dist/`, so build first. `just docs-test` needs Rust: `scripts/check-api-contract.mjs` compiles the live tool catalog, fails on drift from the snapshot, and checks that every OpenAPI operation exists in the Axum router.

## Agent skill

The instruction-only skill lives in `skills/scout-qa`, with its file allowlist and version in `skills/manifest.json`. From the repository root:

```sh
just skill-install codex      # python3 scripts/install-scout-skill.py --client codex
python3 scripts/install-scout-skill.py --client claude --project /path/to/app
just skill-test
```

The installer only copies files (Python 3.9+ standard library); it does not configure MCP and leaves conflicting files in place.

## Editorial rules

Describe implemented behaviour and label anything not built yet. Keep app observations separate from human confirmation. Never publish credentials, private recordings, personal paths or internal planning estimates. Update a page's `reviewed` date when you review a substantive change.
