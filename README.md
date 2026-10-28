# Scout QA

A local exploratory QA system inspired by Momentic Mo. The product design starts with a URL, infers likely user flows, records every action, and checks the result against an expectation established before acting.

**Implemented:** a user workspace and operations console; a Rust/Axum API and durable OpenAI/Claude/OpenRouter gateway; per-user usage accounting; Docker Compose and just commands; PostgreSQL, ClickHouse and a private S3-compatible bucket; all seven supplied screenshots archived with unique IDs and verified hashes; lossless screenshot differences; a bounded URL-driven Chromium explorer with model predictions, per-action assessments and a persisted flow graph; and fresh-browser replay of suspected bugs, including optional bounded automatic scheduling. The GUI submits durable jobs to a background browser worker, displays stored evidence, and cancels queued or active work with recovery across restarts. Human reviewers can confirm or dismiss findings with versioned evidence and review history. Every model attempt records request/response evidence and nullable usage, with recovery and replay-safe export. **Still to build:** live-model quality validation, subscription authentication, isolation for arbitrary target apps, external identity-provider handoff, resume and multiple workers.

Start the local services from this directory:

```sh
bash scripts/start-local.sh
```

With just installed, use `just dev`, `just demo`, and `just runs`. This machine also has a verified copy at `.tools/bin/just`. Open **http://127.0.0.1:18080** for the workspace and switch to **Back office** for Operations. Local development sign-in is disabled on this machine with `SCOUT_DEV_AUTH_BYPASS=true`. Set it to false in the private `.env` and run `just dev` to restore the token screen; source defaults and authentication fixtures retain normal token access. Both interfaces represent the same local developer, without separate administrative permission roles. The browser worker starts with the ordinary Compose stack.

The user workspace now follows a submitted job from its queue state into its run, keeps pre-launch failures visible, and provides setup guidance, scoped run/review filters, action-budget summaries and native-pixel screenshot/mask/frame inspection with side-by-side Before/After comparison and previous/next action navigation. Refresh preserves text composition, selection, disclosures and relevant scroll positions. The back office adds readiness and delivery snapshots, queue filters, per-run model request/attempt filters, nullable usage and event search. Service outbox counters are not direct health probes; Connections now saves nonsecret exploration defaults as append-only revisions without a restart. New jobs freeze the effective revision; admitted jobs and their retries keep their original settings. Provider keys and allowed origins remain in `.env`. See [the GUI guide](./WORKSPACE_UI.md) for scope and limits.

- [Running services, screenshot retrieval, and verification](./LOCAL_INFRASTRUCTURE.md)
- [User workspace and operations console](./WORKSPACE_UI.md)
- [Portable Markdown reports and verified evidence ZIPs](./REPORT_EXPORT.md)
- [Screenshot IDs and object manifest](./artifacts/reference-screenshots/manifest.json)
- [Architecture and implementation sequence](./ARCHITECTURE_AND_BUILD_PLAN.md)
- [Model connection modes and token accounting](./LOCAL_STACK_AND_MODELS.md)
- [Model gateway: connect a provider, submit calls, inspect usage](./MODEL_GATEWAY.md)
- [URL exploration: run it, inspect graphs, understand current limits](./EXPLORATION.md)
- [Exploration algorithm: likely next actions, changed controls, branch returns and responsive coverage](./EXPLORATION_PLANNER.md)
- [Browser interactions: text, dropdowns, checkboxes, radios and scrolling](./BROWSER_INTERACTIONS.md)
- [Action completion, form submissions and network/console evidence](./ACTION_OUTCOMES.md)
- [Run cancellation, retained evidence and late provider usage](./CANCELLATION.md)
- [Private app login and saved sessions](./AUTH_HANDOFF.md)
- [Human finding review, confirmation and versioned training labels](./FINDING_REVIEWS.md)
- [Bug reproduction: replay a suspect action and inspect fresh evidence](./REPRODUCTION.md)
- [Automatic reproduction: optional bounded rechecks, reservations and batch stop](./AUTOMATIC_REPRODUCTION.md)
- [Evidence and training-data contract](./EVIDENCE_AND_TRAINING_DATA.md)
- [Product, data model, APIs, and acceptance criteria](./PRODUCT_IMPLEMENTATION_PLAN.md)
- [Browser runtime and recovery](./BROWSER_RUNTIME_DESIGN.md)
- [Momentic research with public sources](./MOMENTIC_RESEARCH.md)
- [Pixel-difference prototype](./packages/image-diff/README.md)
- [Browser recorder: demo, verification, and recovery](./packages/browser-runtime/README.md)
- [Rust API endpoints and tests](./apps/api/README.md)
- [Local commands and Kubernetes deployment direction](./DEPLOYMENT_AND_DEVELOPMENT.md)
- [Recorded demo results and evidence IDs](./artifacts/runtime-demo/results.json)

Use `just models`, `just model-call request.json`, `just model-request REQUEST_UUID`, and `just usage` for the gateway. `just model-test` uses fake providers and restores normal mode afterward. Live providers require optional API keys in `.env`; no account was connected or billed during fixture verification.

Use `just explorer-test` to verify exploration and reproduction with simulated models and real browser/storage services. With a configured provider, use `just explore URL` for an explicitly allowed controlled app. No brief is required. Use `just reproduce ACTION_UUID` to recheck a suspected bug in a fresh browser; repeated commands reuse the saved attempt without new model calls. Local volumes preserve evidence across container recreation; they are not an off-machine backup.

Open a run and choose **Export report** to download readable Markdown, the existing JSON snapshot, or a portable evidence ZIP with verified PNGs/artifacts and a SHA-256 manifest. Missing evidence stays explicit; related replay evidence is exported separately. `just export-report RUN_UUID` uses the same implementation from the terminal. These downloads do not approve training use or make model calls. See [portable reports](./REPORT_EXPORT.md).

The URL form also offers **Automatically recheck suspected bugs**, off by default. After an opted-in queued exploration completes, the worker reserves up to two eligible cases and twelve additional replay actions in total, including each prerequisite path. Rechecks use the original provider, execution mode, viewport and saved sign-in context. Reservations are permanent; cancelled or interrupted checks are not automatically retried. **Stop automatic checks** remains available after the parent exploration finishes. Results still require human review. See [automatic reproduction](./AUTOMATIC_REPRODUCTION.md) for configuration, deferrals, evidence and `just auto-reproduction-test`.

The explorer now ranks reachable unexplored branches using model intent scores, exact screenshot changes within controls, novelty and return cost. It records the discovery tree, returns through assessed routes, replans stale screens, and exposes its choices in the Flow tab. Choose a desktop/tablet/mobile profile in the URL form or use `just explore-matrix URL` for three separate runs. Scores are uncalibrated estimates; complete app coverage is not claimed.

Native text/search entry, dropdown selection, checkbox/radio changes and document scrolling now share that loop and preserve their parameters during fresh replay. The queued worker now supports [private manual app login and encrypted session reuse](./AUTH_HANDOFF.md). The loop also supports bounded action completion, sampled screenshot timelines, network/console diagnostics, and search or explicitly permitted test-form submissions. External identity providers and custom widgets remain future work.

Use `just web-test` for all `apps/web/*.test.mjs` suites; 96 JavaScript tests currently pass, alongside 35 Rust API tests. These exercise rendering and simulated DOM events without launching a browser. `just web-contract-test` also runs `scripts/verify-gui-contract.mjs` against persisted summaries, actual model-attempt records and served assets; the current contract checks passed across 50 runs and 192 recorded attempts. Use `just workspace-test` for authenticated API, job queue, real worker, evidence retrieval and interruption recovery. Use `just settings-test` to verify saved-default durability, concurrent revisions and admission snapshots with the browser worker stopped; it makes no model calls and restores the previous preferences. Workspace, back-office, editable-defaults, comparison and evidence-drawer interactions were visually checked at narrow and desktop breakpoints after enabling local development access. Broader browser/layout coverage and live-model QA quality remain unverified.
