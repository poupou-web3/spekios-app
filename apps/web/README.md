# Customer workspace

The interface customers use: launch explorations, follow runs, review evidence and findings, connect an agent, verify fixes and manage settings. `scout-api` embeds and serves it at http://127.0.0.1:18080. It contains no operator back office code or links; that console lives in [`apps/backoffice`](../backoffice/README.md) and ships separately.

```
index.html, connect.html, issues.html   page shells (CSP-safe: external scripts and styles only)
src/
  main.js          entry: delegated events, polling, startup
  app.js           render, refresh, hash routing (#/workspace[/<run>[/<action>]], #/settings)
  state.js         shared state; values several modules change live on `state`
  api.js, images.js, jobs.js, shell.js, private-login.js
  views/           home, run, action, review, steering, automatic, flow, settings, drawer, export
  report/          Markdown / evidence ZIP / JSON report builders (pure modules)
  connect.js       agent connection page
  issues.js        issue history and fix verification page
  styles/          workspace.css, pages.css (connect + issues)
test/              node --test suites; support.mjs links src/ for the vm sandboxes
```

`apps/api/build.rs` lists every `.js` and `.css` file under `src/` at compile time. Adding a module needs no Rust change, but the API must be rebuilt (`just dev`) to serve it.

Shared formatting, components, theme and styles come from [`packages/web-ui`](../../packages/web-ui/README.md). Run `just web-test`.
