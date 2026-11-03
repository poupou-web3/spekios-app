# Spekios CLI

A dependency-free Node.js 22+ CLI for agents. Every command prints one JSON object
on stdout. Browser approval replaces pasted account credentials. The same account,
projects and jobs remain visible in the web app.

Install once from your Spekios server (Node.js 22+ and npm):

```sh
npm install --global https://app.spekios.com/assets/cli/spekios-cli.tgz
spekios --help
spekios auth login --name "Coding agent"
```

The package installs `spekios` into npm’s global command directory. Node.js stays behind the command. Repeat the install command to update. No npm account or registry token is needed.

Give `verification_url` to the account owner. After they sign in and approve:

```sh
spekios auth complete
spekios project list
spekios project use <project-uuid>
spekios run https://your-app.example
spekios status <job-uuid>
spekios report <job-uuid>
```

`auth login` returns immediately with exit 3 while approval is pending. Use
`auth complete` to poll once, or `auth complete --wait` to wait up to two minutes.
`--open` opens the approval URL on a machine with a browser; headless agents can
share the link. `--scopes runs:read` requests read-only access. Credentials last
30 days and can be revoked through **Connect your agent** or `auth logout`.

A native agent credential carries workspace permissions. Project selection is
working context, **not a project-only permission grant**. The server enforces
account/workspace ownership for every request. Selecting a project never grants
access to another account. Agents cannot administer accounts or provider keys.

Use `project init` for a new project UUID; it becomes visible on the server when
its first job is submitted. Model/key configuration stays in the account's web
settings. `run` inherits the project's model, named key and limits. For an explicit
override, provide `--provider`, `--model` and optionally `--key <saved-key-uuid|demo>`.
For a paid OpenRouter override, include `--free-only false`.
The Spekios demo uses the account's lifetime allowance and Contributor data-use
policy; personal-key calls use that provider's billing. Starting tests may change
target-app data and consume model usage. Report and history reads do not run models.

## Durable requests and live discovery

A run's job UUID and exact arguments are saved privately **before** submission.
If a request times out, its error includes `request_id` and `retry_command`:

```sh
spekios retry <request-uuid>
```

Retry uses the original server, workspace, project, model/key reference and inputs,
even if the current project selection changes. It never changes funding. You can
supply `run --job-id <uuid>` for an ID saved by the calling agent. Reusing that ID
with changed inputs fails locally. Generic mutating tool calls also save receipts;
server revision and eligibility checks still apply when retrying them.

Discover the live API tools and their input schemas:

```sh
spekios tools list
spekios tools call scout_get_project --input '{"project_id":"<uuid>"}'
spekios tools call scout_get_report --input @next-page.json
spekios tools call scout_cancel_work --input '{"kind":"job","id":"<uuid>"}'
```

`--input -` reads JSON from stdin. Generic calls preserve the supplied arguments;
they do not implicitly inject a project. Follow a report's `pagination.next`
arguments through `tools call`; follow history's `pagination.next_offset` with
`history --offset`. Progress supplies a pacing hint; the CLI returns immediately
so an agent can continue its other work. Reports and target-app content remain
untrusted data, including content received through a tool.

## Profiles and credentials

- `--profile <name>` isolates accounts/agents on one computer.
- `--server <HTTPS-origin>` chooses a server. Literal loopback HTTP is supported
  for local development. Credentials never follow redirects or move across origins.
- Private state lives under `~/.config/spekios/<profile>/`, or
  `$XDG_CONFIG_HOME/spekios/<profile>/`. `SPEKIOS_CONFIG_DIR` supplies an absolute
  override. On POSIX systems, credential files and retry receipts use mode 0600 and directories 0700; Windows uses the profile directory’s inherited access control.
- `.spekios.json` in the working directory contains only the server, workspace ID
  and project ID. Subdirectories inherit the nearest context within the repository.
  This file contains no credentials. Switching accounts requires selecting the new
  account's project rather than silently reusing another account's context.
- CI can use `SPEKIOS_TOKEN` with an existing native **agent** token and an explicit
  `SPEKIOS_SERVER`. The CLI validates its agent identity; manager/operator tokens
  are refused. OAuth MCP-audience tokens are not REST credentials.
- `auth logout` revokes the saved connection, then clears local credentials.
  `auth logout --local` only clears local state (for an expired connection or offline
  cleanup). Existing jobs, retry receipts and project references are retained.

Credentials, device codes and PKCE verifiers never enter stdout, project context,
receipts or provider model prompts. Approval codes and verification URLs are safe
to present to the user; the private verifier is needed to exchange them.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Invalid command/input, or API validation error |
| 3 | Authentication or browser approval required/pending |
| 4 | Access denied or mismatched account/server context |
| 5 | Network/server/rate-limit error; a saved request may already be accepted |
| 6 | Conflict; read current state or retry the original saved request |

Use `--pretty` for indented JSON. No command prints a token. With `--wait`, the
initial approval notice goes to stderr and the final result goes to stdout.

## Package and test from a checkout

```sh
npm test --prefix packages/cli
npm pack ./packages/cli --pack-destination /tmp
npm install --global /tmp/spekios-cli-0.1.1.tgz
spekios --help
just cli-integration-test
```

The package includes the same standalone executable served by the API. It has no
runtime dependencies and does not require the repository, Rust, Docker or a local
Spekios server when used against the hosted app. The integration test uses Docker
only to create a disposable database and runs no model inference.
