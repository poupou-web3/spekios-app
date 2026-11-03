# Customer workspace

The interface customers use: launch explorations, follow runs, review evidence and findings, connect an agent, verify fixes and manage settings. `scout-api` embeds and serves it at http://127.0.0.1:18080. It contains no operator back office code or links; that console lives in [`apps/backoffice`](../backoffice/README.md) and ships separately.

```
index.html, connect.html, issues.html   page shells (CSP-safe: external scripts and styles only)
src/
  main.js          entry: delegated events, polling, startup
  app.js           render, refresh, path routing (/website/<origin>[/tests], /workspace[/<run>[/<action>]], /settings[/<section>])
  navigation.js    in-page navigation between workspace paths; old #/ addresses still open
  state.js         shared state; values several modules change live on `state`
  api.js, images.js, jobs.js, shell.js, private-login.js
  websites.js, website-state.js, website-page.js  grouping, switcher and shared page navigation
  views/           landing, home, run, action, review, steering, automatic, flow, settings, activity, drawer, export
  report/          Markdown / evidence ZIP / JSON report builders (pure modules)
  connect.js       agent connection page
  issues.js        issue history and fix verification page
  styles/          workspace.css, pages.css (connect + issues)
test/              node --test suites; support.mjs links src/ for the vm sandboxes
```

`apps/api/build.rs` lists every `.js` and `.css` file under `src/` at compile time. Adding a module needs no Rust change, but the API embeds these files, so serve a UI change with `just reload` (or `just reload-api`). `just dev` is only needed to bring the whole stack up.

Addresses are plain paths. The API serves `index.html` for `/workspace…`, `/website/…` and `/settings…`, and inside the workspace a link to one of them changes the page without reloading (`src/navigation.js`); Back and Forward work as usual. Old `#/…` addresses (and `/issues#<id>`) still open their page and are rewritten to the path. The selected issue is `/issues/<id>`.

Every sidebar ends with Activity, Connect your agent and Settings below a separator, and Connect your agent and Issues & fixes use the workspace's top bar, so moving between pages never shifts the layout. On those two pages Activity links to `/workspace?activity`, which opens the Activity panel.

`build.rs` also gives every asset URL the build's version (`/assets/v<hash>/app/…`) and adds `<link rel="modulepreload">` for each page's whole module graph. Versioned files are served `Cache-Control: public, max-age=31536000, immutable`, so after the first visit pages load from the browser cache; a new build changes every URL. Unversioned asset paths still answer, uncached.

Shared formatting, components, theme and styles come from [`packages/web-ui`](../../packages/web-ui/README.md). Run `just web-test`.

`/workspace` is the project list: one project per website origin, with counts of findings to review, confirmed findings and tests across every run of that origin (from the `/v1/runs` website catalog), what needs attention across projects and the latest tests. It opens no project by itself; with no project yet it is the first-test page. The project list and settings use a workspace sidebar; every project page links back with **All projects**. A newly submitted test opens its project's overview, which follows the job to its run.

The website switcher groups entry URLs by origin, keeping staging subdomains and local ports separate. Its catalog covers the complete owned run history; selected-website test history pages through 50 runs at a time. The overview shows the latest tests, while Tests retains search, filters and usage. Stopped explorations offer Continue exploration and Run again from their cards, history and report. Issues use the same exact origin filter. Recent shortcuts are limited to three per website in this tab, with icons for reports, findings, flow maps and pages. Settings and agent connection remain workspace actions at the bottom.

The account menu (top right, `src/account-menu.js`, also on Connect your agent and Issues & fixes) shows the workspace name and how you signed in, browser worker and model gateway status, the theme, a switch for pop-up notifications, links to settings and agent connection, and **Sign out**. The workspace never receives the person's email: `/v1/identity` deliberately omits it.

Connect your agent and Issues & fixes are separately served pages. They draw their sidebar as soon as their script runs and keep the sidebar column from the first paint, so nothing moves when the website list arrives; only a visible sign-in panel uses the full width. Connect your agent uses the workspace sidebar.

Pop-up notifications (bottom left, `src/notifications.js`) compare each refresh with the previous one and report only new findings on a project, a finished or stopped test, a fix-check result and a sign-in request. Queued and started tests, progress and cancellations are not notified, and nothing is reported for what was already there when the page opened. Failures and sign-in requests stay until dismissed; the rest close after 10 seconds. The switch is stored per browser.

Activity opens from the bottom of the workspace sidebar, or the sticky mobile footer. Its side panel (bottom sheet on mobile) shows running jobs across websites, private sign-in requests with per-run skip and account-creation choices, workspace refresh errors and the ten most recent job results. It never opens automatically or inserts background work into a report, overview or settings page. The job API includes all active jobs and the fifty latest finished jobs so older running work stays visible. The panel keeps polling while open; evidence and export drawers retain their existing polling behavior. A newly submitted test still follows its own run until the user navigates elsewhere.

The overview and both switcher entry points share URL normalization for local hosts and Docker addresses, including loopback guidance that updates without replacing the input. Model-price links retain their target until settings finish refreshing, and manual navigation cancels a pending target.

Favicons load directly from the website origin with no referrer and a globe fallback; no third-party favicon service receives the tested URL. The workspace CSP allows HTTP/HTTPS images for these icons, while scripts, styles and API requests remain same-origin. `styles/websites.css` applies this navigation to all customer pages.

## Spekios appearance

The customer theme in `src/styles/spekios.css` follows the [Spekios Lovable project](https://lovable.dev/projects/a393e034-e3f2-4e09-9456-d2b48479023a): paper surfaces, Instrument Serif display type, Geist body/mono type, charcoal actions, terracotta accents and a circular signal mark. It loads after the shared styles on all three customer pages, leaving the operator console's theme independent. Dark mode uses warm charcoal surfaces and preserves the existing system/light/dark controls.

Fonts and OFL licenses live in `src/fonts/`; the API embeds a closed list of font files and serves them from the same origin without changing the CSP or depending on Google Fonts at runtime. Public copy uses Spekios; internal API names, environment variables and browser storage keys retain Scout for compatibility.
