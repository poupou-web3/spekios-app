# Customer workspace

The interface customers use: launch explorations, follow runs, review evidence and findings, connect an agent, verify fixes and manage settings. `scout-api` embeds and serves it at http://127.0.0.1:18080. It contains no operator back office code or links; that console lives in [`apps/backoffice`](../backoffice/README.md) and ships separately.

```
index.html, connect.html, issues.html   page shells (CSP-safe: external scripts and styles only)
src/
  main.js          entry: delegated events, polling, startup
  app.js           render, refresh, hash routing (#/website/<origin>[/tests], #/workspace[/<run>[/<action>]], #/settings[/<section>])
  state.js         shared state; values several modules change live on `state`
  api.js, images.js, jobs.js, shell.js, private-login.js
  websites.js, website-state.js, website-page.js  grouping, switcher and shared page navigation
  views/           home, run, action, review, steering, automatic, flow, settings, drawer, export
  report/          Markdown / evidence ZIP / JSON report builders (pure modules)
  connect.js       agent connection page
  issues.js        issue history and fix verification page
  styles/          workspace.css, pages.css (connect + issues)
test/              node --test suites; support.mjs links src/ for the vm sandboxes
```

`apps/api/build.rs` lists every `.js` and `.css` file under `src/` at compile time. Adding a module needs no Rust change, but the API embeds these files, so serve a UI change with `just reload` (or `just reload-api`). `just dev` is only needed to bring the whole stack up.

Shared formatting, components, theme and styles come from [`packages/web-ui`](../../packages/web-ui/README.md). Run `just web-test`.

The website switcher groups entry URLs by origin, keeping staging subdomains and local ports separate. Its catalog covers the complete owned run history; selected-website test history pages through 50 runs at a time. The overview shows the latest tests, while Tests retains search, filters and usage. Issues use the same exact origin filter. Recent shortcuts are limited to three per website in this tab, with icons for reports, findings, flow maps and pages. Settings and agent connection remain workspace actions at the bottom.

Favicons load directly from the website origin with no referrer and a globe fallback; no third-party favicon service receives the tested URL. The workspace CSP allows HTTP/HTTPS images for these icons, while scripts, styles and API requests remain same-origin. `styles/websites.css` applies this navigation to all customer pages.

## Spekios appearance

The customer theme in `src/styles/spekios.css` follows the [Spekios Lovable project](https://lovable.dev/projects/a393e034-e3f2-4e09-9456-d2b48479023a): paper surfaces, Instrument Serif display type, Geist body/mono type, charcoal actions, terracotta accents and a circular signal mark. It loads after the shared styles on all three customer pages, leaving the operator console's theme independent. Dark mode uses warm charcoal surfaces and preserves the existing system/light/dark controls.

Fonts and OFL licenses live in `src/fonts/`; the API embeds a closed list of font files and serves them from the same origin without changing the CSP or depending on Google Fonts at runtime. Public copy uses Spekios; internal API names, environment variables and browser storage keys retain Scout for compatibility.
