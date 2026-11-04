# Operator back office

The console for the team running Scout: service readiness, browser job queue, model requests and attempts, ordered runtime events, live service logs, and read-only server configuration. It is a separate deployment from the customer workspace. The `backoffice` Compose service builds `infra/backoffice/Dockerfile`, serves this app with nginx at http://127.0.0.1:18083, and proxies `/v1` and `/readyz` to the internal API.

- Publish it only on a private network or VPN. Sign in with the operator token (`SCOUT_API_TOKEN`); local development access opens it directly.
- Views are addressable: `#/overview`, `#/jobs`, `#/models/<run>`, `#/events/<run>`, `#/logs[/<run>]`, `#/connections`.
- Logs tails every container's output from ClickHouse every 1.5 seconds ([service logs](../../docs/platform/logs.md)).
- It never links into the customer workspace. Runs are inspected here through the run picker.

```
index.html
src/
  main.js        entry: events, polling, startup
  app.js         sign-in, frame, render, refresh, routing
  state.js, api.js
  views/         operations (overview + tabs), jobs, models, events, logs, connections, drawer
  styles/        backoffice.css
test/            node --test suites; support.mjs links src/ for the vm sandboxes
```

Shared formatting, components, theme and styles come from [`packages/web-ui`](../../packages/web-ui/README.md). Run `just web-test`; `just backoffice` starts the stack and prints the URL. After the stack is already up, `just reload-backoffice` rebuilds only this console.
