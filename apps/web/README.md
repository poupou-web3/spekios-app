# Customer workspace

The interface customers use: start explorations, follow runs, review evidence and findings, connect an agent, verify fixes and manage settings and provider keys. It is plain ES modules and CSS with no build step. `scout-api` embeds these files at compile time and serves them on http://127.0.0.1:18080; everything it shows comes from the API's `/v1` routes. It contains no operator code or links; that console is [`apps/backoffice`](../backoffice/README.md), deployed separately.

```
index.html, connect.html, issues.html   page shells (CSP-safe: external scripts and styles only)
src/
  main.js          entry: delegated events, polling, startup
  app.js           render, refresh, path routing
  navigation.js    in-page navigation between workspace paths; old #/ addresses still open
  state.js         shared state; values several modules change live on `state`
  api.js, images.js, jobs.js, shell.js, private-login.js, provider-keys.js, computer-use.js, posthog.js
  websites.js, website-state.js, website-page.js   per-website grouping, switcher and page navigation
  account-menu.js, notifications.js, agent-handoff.js
  views/           landing, home, run, action, review, steering, automatic, flow, settings, activity, drawer, export
  report/          Markdown / evidence ZIP / JSON report builders (pure modules)
  connect.js       Connect your agent page
  issues.js        Issues & fixes page
  styles/          workspace.css, pages.css, websites.css, spekios.css (customer theme)
  fonts/           Geist, Geist Mono and Instrument Serif with their OFL licenses
test/              node --test suites; support.mjs links src/ for the vm sandboxes
```

## How it is served

- Addresses are plain paths: `/workspace[/<run>[/<action>]]`, `/website/<origin>[/tests]`, `/settings[/<section>]` all return `index.html`; `/connect` and `/issues[/<id>]` are their own pages. Old `#/…` addresses are rewritten to the path.
- `apps/api/build.rs` embeds every `.js` and `.css` file under `src/`, plus the fonts, as a closed list. Adding a module needs no Rust change, but a UI change only appears after rebuilding the API: `just reload-api` (or `just reload` for the API and back office).
- Asset URLs carry the build's version (`/assets/v<hash>/app/…`) and are cached as immutable; each page gets `<link rel="modulepreload">` for its module graph. Unversioned asset paths still answer, uncached.
- Shared formatting, components, theme and base styles come from [`packages/web-ui`](../../packages/web-ui/README.md), served at `/assets/ui/`. `spekios.css` loads after them on the three customer pages, so the back office keeps its own theme.
- Website favicons load directly from the tested origin with no referrer; scripts, styles and API requests stay same-origin.

Public copy says Spekios; internal API names, environment variables and browser storage keys keep the Scout name.

## Test

```sh
just web-test           # node --test for apps/web, packages/web-ui and apps/backoffice
just web-contract-test  # renders stored run snapshots through the UI templates (stack running)
```

What each page does is described in [workspace and back office](../../docs/platform/workspace.md).
