# Exploratory QA product reference

Research date: 14 October 2026. The attached screenshots are visual evidence supplied by the user. Our implementation direction was revised for the user's requirements, with a consistency review on 21 October 2026. The current delivery scope and actual local infrastructure status live in [Architecture and build plan](./architecture.md) and [Local infrastructure](../platform/infrastructure.md).

## The product

The screenshots show an exploratory QA session. A user submits a running app; the system plans coverage and returns a report. That session is distinct from a later regression workflow that stores repeatable tests. Connected repositories, when added, are read-only context: they do not launch the application and they do not write regression files. The initial product is an exploratory session with inspectable evidence, followed later by an optional regression workflow.

The screenshots show a three-column interface: workspace navigation, conversation/activity, and a report with Agents, Test cases, and Bugs tabs. They also show searchable lists, live counters, queued capacity, session cost, authentication blockers, screen replay, schedules, environments, and knowledge. These observations establish the visible interaction model.

## Feature map

| Area | Product behavior | Consequence |
|---|---|---|
| Agent roles | A session agent coordinates and deduplicates. Explore maps areas and proposes cases. Case execution runs a case. A reproducer independently checks a suspected defect. Each sub-agent has its own browser. Functional bugs require separate reproduction; static findings use screenshots. | Separate discovery, execution, and confirmation. A suspected failure must not automatically become a confirmed bug. |
| Session settings | Exploration granularity, concurrency cap, and named environment. Concurrency has a configured maximum. | Bound execution; visibly distinguish queued work from active workers. |
| Steering | Cases and findings arrive during execution. Messages can change scope between tool calls. Stopping the coordinator and stopping all sub-agents are distinct operations. | Persist commands and expose explicit stop scope. |
| Test setup | Credentials can be reused through saved authentication state. Setup and teardown can prepare and clean test data. | Isolate browser state and allocate data per case where backend state can conflict. |
| Scheduling | A schedule stores prompt, cron, time zone, environment, and concurrency; each occurrence creates a new session. | Preserve run history and the exact configuration used. |

Concurrency controls throughput, not total planned coverage. Session cost includes agent runtime, browser time, and inference. The screenshots' 200+ agents therefore do not imply 200+ simultaneous browsers.

Reports use structured cases containing name, summary, preconditions, outline, and acceptance criteria. Verdicts distinguish verified behavior, issues found, and blocked coverage, with explicit gaps and control-level results. An unverified case is not evidence of a pass. Findings contain expected versus actual behavior, reproduction steps, and recording or screenshot references. Exported reports separate cases, verdicts, bugs, and triage, with an artifact manifest. This supports a useful handoff to coding agents and avoids forcing consumers to parse chat text.

Triage supports acceptance, intended behavior, inability to reproduce, duplicates, and reset. When behavior is intended, a human reviews a suggested knowledge entry; later runs can retrieve that context. Disposition alone does not teach the next session unless its explanation becomes reusable knowledge.

The agent interface supports starting, reading, steering, waiting, stopping, reporting, cost inspection, and session file transfer. A start response returns before the work finishes. Status distinguishes active work, waiting on workers, needed user input, idle, failed startup, and cancellation. Private or local targets can be exposed through a tunnel scoped to specified addresses. The first version ships a web interface with the same operations available over MCP and HTTP.

## Chosen implementation

Browser automation uses Playwright, with navigation management that pauses other Playwright operations until navigation completes.

Model inputs include screenshots, HTML/accessibility snapshots, prompts, and traces. Tools have schemas and runtime validation. Role-specific model routing is an explicit configuration choice. A provider listing does not assign a particular model to a particular agent.

The control plane is a Rust/Axum API with PostgreSQL, TypeScript/Playwright workers, S3-compatible screenshot storage, and ClickHouse for observability and event streaming. Services run on one machine with Docker Compose and just. Task leasing starts in PostgreSQL; deployment and queue complexity are added when needed. Preserve IDs and state transitions so UI refreshes cannot create duplicate work or change counts. Profile image work before replacing the tested comparison module.

## Later regression capabilities

A later regression library can mix deterministic preset steps, bounded AI actions, reusable modules, and code. Execution, selection, classification, and repair are adjacent capabilities; they are much larger than the exploratory interface and stay a later step.

A step cache can store intent-relevant visual, positional, text, accessibility, and structural signals. Valid matches replay without model inference; misses invoke a resolver. AI actions can cache a sequence and conditional branches. Assertions and extraction remain evaluated rather than cached outcomes. Branch and environment isolation reduce cross-run interference.

Locator replay can generate multiple selectors and a node snapshot after locating an element, vote across selector matches, and validate attributes and related elements that matter to the user's intent. Cache storage can move from PostgreSQL to ClickHouse for that subsystem only. Hit rate is measured here; it is not assumed. The cache does not replace PostgreSQL as the operational database.

Memory can retrieve selected earlier locator and assertion decisions, scoped to the workspace, and expire after a period of inactivity. An app graph can fingerprint states using canonical URLs and normalized minhashed DOM, embed semantic summaries, and cluster journeys and variants. Both are optional later features, not part of every session.

The knowledge base stores terminology, agent rules, workflows, and generated code insights. Entries support app, environment, and test scoping, semantic retrieval, reviewable suggestions, version history, and usage citations. For the first iteration, scoped human-authored product expectations are more valuable than an elaborate autonomous memory system.

## Implementation direction

Build a web-only vertical slice first: a URL alone launches bounded exploration of a staging app. Infer likely user goals, freeze the expected result before each action, and assess each outcome using unique before/after captures, difference masks, and context. Generated cases execute independently. Suspected functional defects receive a fresh-browser reproduction and a check that the expectation is justified. The report exposes evidence, gaps, and triage. A brief is optional later context. Use the screenshots' interaction pattern for the product's own workspace.

Keep orchestration deterministic around the models. Store a session record, versioned plan, task queue, agent attempts, cases, verdicts, findings, artifacts, and append-only events. Workers lease tasks with deadlines and cancellation checks. The coordinator schedules work from validated outputs instead of allowing unbounded recursive spawning. Start with a small concurrency limit and increase it after measuring browser memory and model throughput.

Record URL, viewport, account role, initial state, action history, observations, and acceptance checks for each attempt. Attach evidence to the specific claim it supports. Reproduction uses the same intended preconditions and equivalent disposable data, with a new browser context and a separate attempt. A model assertion alone should not transform inconclusive evidence into a confirmed finding.

Ship environment selection, safe credential references, live activity, search and filter, evidence review, and report export before schedules, integrations, mobile, or caching sophistication. Acceptance tests should focus on the system's promises: a known seeded bug is reproduced, a blocked login stays blocked, duplicate findings merge without losing evidence, restart resumes queued work, cancellation closes workers, and budgets stop further dispatch.

Prompt text, per-role model routing, deduplication, task persistence, the streaming protocol, and browser isolation are specified in the companion documents and implemented as this application's own choices.
