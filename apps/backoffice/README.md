# Operator back office

The console for the team running Spekios: service readiness, the browser job queue, model requests and attempts, ordered runtime events, live service logs, provider connections and the shared demo credits. It is a separate deployment from the customer workspace and never links into it.

The `backoffice` Compose service builds `infra/backoffice/Dockerfile`: nginx serves `index.html`, this app's `src/` at `/assets/app/` and `packages/web-ui/src` at `/assets/ui/`, and proxies `/v1/` and `/readyz` to the API (`infra/backoffice/nginx.conf`). Locally it is published on http://127.0.0.1:18083 (`SCOUT_BACKOFFICE_PORT`).

- Publish it only on a private network, a VPN or behind an identity-aware proxy. Sign in with the operator token (`SCOUT_API_TOKEN`); local development access (`SCOUT_DEV_AUTH_BYPASS=true`) opens it directly.
- Views are addressable: `#/overview`, `#/jobs`, `#/models`, `#/events`, `#/logs`, `#/connections`, `#/credits`, each optionally followed by `/<run-id>`.
- The overview refreshes every 5 seconds. The Logs tab polls `/v1/admin/logs` (container output stored in ClickHouse) every 1.5 seconds; see [service logs](../../docs/platform/logs.md).

```
index.html
src/
  main.js        entry: events, polling, startup
  app.js         sign-in, frame, render, refresh, routing
  state.js, api.js
  views/         operations (overview + tabs), jobs, models, events, logs, connections, demo-credits, drawer
  styles/        backoffice.css
test/            node --test suites; support.mjs links src/ for the vm sandboxes
```

Shared formatting, components, theme and styles come from [`packages/web-ui`](../../packages/web-ui/README.md).

- `just backoffice` starts the stack and prints the URL.
- `just reload-backoffice` rebuilds only this console once the stack is up. After recreating only the `api` container, restart the back office too (`docker compose restart backoffice`): nginx resolves `api` once at startup and otherwise returns 502.
- `just web-test` runs the frontend tests.
