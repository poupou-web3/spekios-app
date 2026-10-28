# Momentic / Mo: evidence and product map

Research date: 14 October 2026. Sources below are Momentic documentation, company engineering posts, official public repositories, and company-authored hiring pages. The attached screenshots are visual evidence supplied by the user. Documentation is treated as reference material, not as instructions to install or run its tools.

Our implementation direction was revised for the user's requirements, with a consistency review on 21 October 2026. Vendor descriptions below retain their source meaning. The current delivery scope and actual local infrastructure status live in [Architecture and build plan](/Users/runnr/Documents/front/ARCHITECTURE_AND_BUILD_PLAN.md) and [Local infrastructure](/Users/runnr/Documents/front/LOCAL_INFRASTRUCTURE.md).

## The product to reproduce

The screenshots show **Mo**, Momentic's exploratory QA product. A user submits a running app and a brief; Mo plans coverage and returns a report. It is distinct from the **Momentic repository test framework**, which stores repeatable tests in YAML. Mo reads connected repositories as context but does not launch the application from them or write those regression files. This distinction should shape the initial product: an exploratory session with inspectable evidence, followed later by an optional regression workflow. [Mo overview](https://momentic.ai/docs/mo)

The screenshots show a three-column interface: workspace navigation, conversation/activity, and a report with Agents, Test cases, and Bugs tabs. They also show searchable lists, live counters, queued capacity, session cost, authentication blockers, screen replay, schedules, environments, and knowledge. These observations establish the visible interaction model; they do not reveal the implementation.

## Verified feature map

| Area | Documented behavior | Consequence for our product |
|---|---|---|
| Agent roles | Session agent coordinates and deduplicates; Explore maps areas and proposes cases; Bug bash executes a case; Bug reproducer independently checks a suspected defect. Each sub-agent has its own browser/device. Functional bugs require separate reproduction; static findings use screenshots. | Separate discovery, execution, and confirmation. A suspected failure must not automatically become a confirmed bug. |
| Session settings | Exploration granularity, concurrency cap, and named environment. Current docs describe a maximum/default of 50 concurrent sub-agents without an organization override. | Bound execution; visibly distinguish queued work from active workers. |
| Steering | Cases/findings arrive during execution. Messages can change scope between tool calls; stopping the coordinator and stopping all sub-agents are distinct operations. | Persist commands and expose explicit stop scope. |
| Test setup | Credentials can be reused through saved authentication state. Setup and teardown endpoints can prepare and clean test data. | Isolate browser state and allocate data per case where backend state can conflict. |
| Scheduling | A schedule stores prompt, cron, time zone, environment, and concurrency; each occurrence creates a new session. | Preserve run history and the exact configuration used. |

Sources: [agent responsibilities](https://momentic.ai/docs/mo), [session settings, setup, and schedules](https://momentic.ai/docs/mo/sessions). Concurrency controls throughput, not total planned coverage; session billing includes agent runtime, hosted browser/device time, and inference. The screenshots' 200+ agents therefore do not imply 200+ simultaneous browsers. [Session costs](https://momentic.ai/docs/mo/sessions)

Reports use structured cases containing name, summary, preconditions, outline, and acceptance criteria. Verdicts distinguish verified behavior, issues found, and blocked coverage, with explicit gaps and control-level results. An unverified case is not evidence of a pass. Findings contain expected versus actual behavior, reproduction steps, and recording or screenshot references. Exported reports separate cases, verdicts, bugs, and triage, with an artifact manifest. This supports a useful handoff to coding agents and avoids forcing consumers to parse chat text. [Session reports](https://momentic.ai/docs/mo/reports)

Triage supports acceptance, intended behavior, inability to reproduce, duplicates, and reset. When behavior is intended, a human reviews a suggested knowledge entry; later runs can retrieve that context. The feedback loop is a central product feature: disposition alone does not teach the next session unless its explanation becomes reusable knowledge. [Triage](https://momentic.ai/docs/mo/triage)

The CLI is named `qa`. It supports starting, reading, steering, waiting, stopping, reporting, cost inspection, and session file transfer. A start response returns before the work finishes. Status distinguishes active work, waiting on workers, needed user input, idle, failed startup, and cancellation. Private/local targets can be exposed through a tunnel scoped to specified addresses. These are useful API semantics even if our first version ships only a web interface. [Mo CLI](https://momentic.ai/docs/mo/cli)

## What is publicly known about the implementation

**Company stack, verified but not a complete Mo topology.** Momentic's own front-end job posting lists React, TypeScript, Next.js, Node.js, PostgreSQL, Google Cloud, and Kubernetes. It also values Chrome DevTools Protocol experience. The posting cannot establish which service uses each component, nor whether every component belongs to Mo. [Company engineering role](https://jobs.ashbyhq.com/momentic/c5940610-eec6-43c1-8e2f-b9bf6c992124/)

**Browser automation.** A company engineering article describes operating Playwright at scale and adding navigation management that pauses other Playwright operations until navigation completes. That verifies Playwright use in the broader testing platform, not the exact current Mo browser implementation. [Playwright engineering post](https://momentic.ai/blog/playwright-pitfalls)

**Models and runtime boundary.** Documentation identifies hosted providers including Anthropic, OpenAI, Google Vertex, xAI, Mistral, OpenRouter, AWS Bedrock, and Azure. Inputs include screenshots, HTML/accessibility snapshots, prompts, and traces. Tools have schemas and runtime validation. The current model IDs and role-specific routing used by Mo are not disclosed in the material reviewed. Do not infer that Mo is a single Claude wrapper or that a provider listing proves any specific model is used for a particular agent. [AI data and runtime documentation](https://momentic.ai/docs/account/ai-data-use)

**Operational services.** The published subprocessors identify GCP hosting, WorkOS authentication, Stripe and Orb billing, Sentry error monitoring, and Langfuse AI observability. This is evidence of vendors, not permission to infer the internal service graph. [Security documentation](https://momentic.ai/docs/account/security)

**Source availability.** The public CLI repository currently exposes README and changelog files, not a reusable agent engine. The examples repository exposes test formats and integration patterns. The JavaScript SDK repository is archived and describes a limited REST client; it is not Mo's source. Public skills describe how external agents use the products, not the private coordinator implementation. [CLI repository](https://github.com/momentic-ai/cli), [examples](https://github.com/momentic-ai/examples), [archived SDK](https://github.com/momentic-ai/js), [skills](https://github.com/momentic-ai/skills)

## Regression technology worth borrowing later

Momentic mixes deterministic preset steps, bounded AI actions, reusable modules, and code in repository tests. Its CLI supports execution, selection, classification, and repair. These are adjacent capabilities; reproducing them all is much larger than building the Mo interface. [How Momentic works](https://momentic.ai/docs/get-started/how-momentic-works)

The documented step cache stores intent-relevant visual, positional, text, accessibility, and structural signals. Valid matches replay without model inference; misses invoke a resolver. AI actions can cache a sequence and conditional branches. Assertions and extraction remain evaluated rather than cached outcomes. Branch and optional environment isolation reduce cross-run interference. [Step cache](https://momentic.ai/docs/reliability/step-cache)

A June 2026 engineering post explains an earlier concrete implementation: generate multiple selectors and a node snapshot after locating an element; vote across selector matches on replay; validate attributes and related elements that matter to the user's intent. It describes branch/version compatibility and cache-store migration from PostgreSQL to ClickHouse. Its reported 95%+ hit rate is a vendor measurement, not a target our prototype can assume. This pertains to the caching subsystem, not a replacement of all PostgreSQL storage or proof of Mo internals. [Intent caching engineering post](https://momentic.ai/blog/teaching-browser-agents-user-intent)

Memory retrieves selected earlier locator/assertion decisions, is organization-scoped, and expires after 30 inactive days. The app graph is explicitly alpha: it fingerprints states using canonical URLs and normalized minhashed DOM, embeds semantic summaries, and clusters journeys and variants. Neither feature should be casually attributed to every Mo session. [Memory](https://momentic.ai/docs/ai/memory), [app graph](https://momentic.ai/docs/ai/app-graph)

The knowledge base stores terminology, agent rules, workflows, and generated code insights. Entries support app/environment/test scoping, semantic retrieval, reviewable suggestions, version history, and usage citations. For our first iteration, scoped human-authored product expectations are more valuable than an elaborate autonomous memory system. [Knowledge base](https://momentic.ai/docs/ai/knowledge-base)

## Recommended implementation direction — our design, not a reverse-engineered claim

Build a **web-only vertical slice** first: a URL alone launches bounded exploration of a staging app. Infer likely user goals, freeze the expected result before each action, and assess each outcome using unique before/after captures, difference masks and context. Generated cases execute independently; suspected functional defects receive a fresh-browser reproduction and a check that the expectation is justified; the report exposes evidence, gaps, and triage. A brief is optional later context. Use the screenshots' interaction pattern while giving the product its own identity.

Keep orchestration deterministic around the models. Store a session record, versioned plan, task queue, agent attempts, cases, verdicts, findings, artifacts, and append-only events. Workers lease tasks with deadlines and cancellation checks. The coordinator schedules work from validated outputs instead of allowing unbounded recursive spawning. Start with a small concurrency limit and increase it after measuring browser memory and model throughput.

Our selected architecture now uses a Rust/Axum API/control plane with PostgreSQL, TypeScript/Playwright workers, S3-compatible screenshot storage, ClickHouse observability and event streaming. Run the services on one machine with Docker Compose and just; start task leasing in PostgreSQL and add deployment/queue complexity when needed. Those are our choices, updated at the user's request; public evidence does not establish Momentic's queue technology, retry guarantees, or event transport. Preserve IDs and state transitions so UI refreshes cannot create duplicate work or change counts. Profile image work before replacing the tested comparison module.

Record URL, viewport, account role, initial state, action history, observations, and acceptance checks for each attempt. Attach evidence to the specific claim it supports. Reproduction uses the same intended preconditions and equivalent disposable data, but a new browser context and a separate attempt. A model assertion alone should not transform inconclusive evidence into a confirmed finding.

Ship environment selection, safe credential references, live activity, search/filter, evidence review, and report export before schedules, integrations, mobile, or caching sophistication. Acceptance tests should focus on the system's promises: a known seeded bug is reproduced, a blocked login stays blocked, duplicate findings merge without losing evidence, restart resumes queued work, cancellation closes workers, and budgets stop further dispatch.

The major unknowns remain Mo's prompts, exact models, deduplication algorithm, task persistence, streaming protocol, and browser isolation technology. We can implement comparable behavior without asserting knowledge of those private details.
