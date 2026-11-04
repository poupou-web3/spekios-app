# Service logs

The back office **Logs** tab (`#/logs`, or `#/logs/<run>` for one run) shows what every container in the Compose project prints, with a timestamp, level and service, as it happens. It plays the part of Cloud Run's log viewer for this single-host stack. `docker compose logs` keeps working unchanged.

## How a line gets there

1. A container writes a line to stdout or stderr. Docker stores it as usual.
2. **log-collector** (Vector 0.60, [infra/logs/vector.yaml](../../infra/logs/vector.yaml)) streams the output of every `scout-qa` container through **log-socket**, a Docker API proxy that answers only container listing, inspection, log streaming and events. It joins indented continuation lines (stack traces, object dumps) into one entry, reads the level and inserts a batch into the ClickHouse table `scout.service_logs` ([006-service-logs.sql](../../infra/clickhouse/006-service-logs.sql)) about once a second.
3. `GET /v1/admin/logs` reads the table for operators. The Logs tab asks it for new lines every 1.5 seconds.

Expect one to three seconds between a line being printed and appearing in the tab.

Each line's ID is a hash of its container, stream, Docker timestamp and text. When a container is replaced, the collector re-attaches and can read its last line again; the copy has the same ID, so the viewer drops it and the table (a `ReplacingMergeTree`) merges it away.

The tail pages on `ingested_at`, the time ClickHouse stored a batch, not on the line's own timestamp. The collector sends one batch at a time, so `ingested_at` only moves forward and lines that reach the collector late (from a slower container stream) are still picked up. The tab orders lines by their Docker timestamp.

## What Scout prints

Scout's own services print one JSON object per line: `{"level":"info","msg":"model_call_finished",...}`. The collector keeps `msg` as the message and the other keys as fields, which the tab shows inline and in full when a row is opened.

| Service | Messages | Fields |
| --- | --- | --- |
| api | `http_request` | method, route template, path (only when every route parameter is a UUID), status, elapsed_ms |
| api | `model_request_queued`, `model_call_started`, `model_call_finished`, `model_request_failed`, `model_request_cancelled` | provider, model, provider endpoint, request/call/run/action IDs, attempt, image count, request size, funding source, then state, HTTP status, duration, tokens, reported cost, returned model, provider request ID and error code |
| api | `model_gateway_*`, `model_export_pending` | dispatcher state changes and error codes |
| browser-worker | `worker_started`, `job_started`, `job_finished`, `job_execution_failed`, `worker_stopping` | job, run and worker IDs, kind, provider, model, final status, duration, error class |
| browser-worker | one line per runtime event: `run.started`, `model.decision_requested`, `action.dispatched`, `action.assessed`, `run.completed`… | run ID, action ID, sequence, and allow-listed payload values such as `kind`, `request_id`, `verdict`, `executed_actions` and `stop_reason` |

The worker copies a payload value only if it is a number, a boolean or a short lowercase token (a UUID, an enum, a model name), so free text never reaches a line. Prompts, model output, request and response bodies, query strings, target URLs, page text and credentials are never printed. Those stay in each run's stored evidence, under Model calls and the Event log. The CLI recorder (`just explore`) prints no log lines, so its JSON output stays clean.

Other images (nginx, PostgreSQL, ClickHouse, SeaweedFS, Vector, the proxy) appear exactly as they print, so operators see what `docker compose logs` shows.

## Levels

- JSON lines use their own `level` or `severity`.
- Access-log lines use the status code. 5xx is an error and 4xx a warning. A successful GET or HEAD is debug; anything else is info.
- PostgreSQL lines use their severity (`LOG`, `WARNING`, `ERROR`, `FATAL`…). SeaweedFS lines use their `I`, `W`, `E` or `F` prefix.
- Any other line is an error if it contains a word like error, fatal, panic or exception, a warning if it says warn, and info otherwise.

The API logs successful reads at debug, including the back office's own five-second refresh, so the default **Info and above** view shows changes, model calls and problems. Health probes, static assets and the logs endpoint itself are not logged; the back office nginx does not log the Logs tab's polling either.

## Using the tab

- **Live / Paused** stops and resumes the tail. Scrolling up stops following the newest line, and **Jump to latest** resumes it.
- Search matches message and fields, case-insensitively. Level, service chips and **Only run …** (with a run chosen in the picker) narrow the view. Changing a filter reloads the newest 300 matching lines, and **Load older lines** pages back.
- A row with a run ID links to that run's Model calls and can filter the tab to it. The Model calls tab links back with **Logs**.
- The browser holds at most 1,500 lines, dropping the oldest. ClickHouse keeps everything for 14 days.

## Access and isolation

`GET /v1/admin/logs` requires the operator token (`operator_required` otherwise), like `/v1/admin/demo`. Query values are bound as ClickHouse parameters, and service names and levels are checked before use. Reads run with `readonly=2` and a five-second limit.

log-socket runs as an unprivileged user with the Docker socket's group, read-only, on an internal `logs` network that only log-collector shares; it refuses file archives, exports, image and system calls and every write. Container inspection does include environment variables, so the collector can read them through the proxy. It has no inbound port and talks only to the proxy and ClickHouse. Vector does not interpolate environment variables; a small `exec` secret backend hands it `CLICKHOUSE_PASSWORD`, which `scripts/setup-local.mjs` limits to letters, digits, `_` and `-`.

## Limits

- Lines printed while the collector is stopped are not backfilled. `docker compose logs` still has them.
- Levels for plain-text lines are a heuristic.
- Messages and fields over 16 KiB are cut. A line that starts at column 0 begins a new entry; a closing `}` or `]` at column 0 continues the one above.
- Logs cover this host's containers only. They are not scoped to a workspace: operators see every run's lines, including runs started by signed-in users that the run picker does not list.
- Recreating containers makes the collector print `can not get logs from container which is dead or marked for removal` (HTTP 409) at error level, once per removed container. It is harmless; no lines are lost.

## Operating it

- `just dev` and `scripts/deploy.sh` start log-socket and log-collector with the rest of the stack. On Linux, `deploy.sh` sets `SCOUT_DOCKER_GID` from the socket. Set `SCOUT_DOCKER_SOCKET` for a rootless Docker socket.
- After editing `infra/logs/vector.yaml`, run its tests and restart the collector:

  ```sh
  docker run --rm -e CLICKHOUSE_PASSWORD=x -v "$PWD/infra/logs/vector.yaml:/etc/vector/vector.yaml:ro" \
    timberio/vector:0.60.0-alpine test /etc/vector/vector.yaml
  just reload-logs
  ```

- `scripts/apply-schemas.sh` creates the table on an existing ClickHouse volume; a fresh volume gets it at first start.
- If the tab says logs are unavailable, check `docker compose ps log-collector` and `docker compose logs log-collector`.
