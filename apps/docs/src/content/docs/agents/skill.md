---
{
  "title": "Install the lightweight agent skill",
  "description": "Install Spekios’s small Agent Skills package for Codex, Claude Code or a compatible agent, then submit URLs and retrieve evidence-backed feedback.",
  "reviewed": "2026-10-29",
  "sidebar": {
    "order": 0
  }
}
---
Install the **scout-qa** skill to give an agent a short starting workflow for Spekios. It explains which tools to call, how to return for a report and how to investigate findings without confusing AI suspicion with human confirmation.

The package contains three text files: **SKILL.md**, client metadata and an optional HTTP reference. There is no SDK, daemon, executable hook, embedded token or automatic MCP configuration. Only the small entry point needs to be loaded for ordinary use.

## Install from a Spekios checkout

Run from the repository root, using Python 3.9 or newer:

~~~sh
# Codex: install for the current user.
python3 scripts/install-scout-skill.py --client codex

# Claude Code: install for the current user instead.
python3 scripts/install-scout-skill.py --client claude
~~~

The installer uses only Python's standard library. It copies the allowlisted instruction files into a new **scout-qa** folder and does not start Spekios, spend model usage or change client permissions.

| Client | User installation | Project installation |
| --- | --- | --- |
| Codex | ~/.agents/skills/scout-qa | .agents/skills/scout-qa |
| Claude Code | ~/.claude/skills/scout-qa | .claude/skills/scout-qa |

For a project-scoped installation, supply an existing target project directory:

~~~sh
python3 scripts/install-scout-skill.py --client codex --project /path/to/your-app
~~~

Use `--dry-run` to inspect the destination without writing. Use `--skills-dir /your/skills` for another compatible client or a custom discovery directory. The installer always adds the **scout-qa** child folder.

Installing the same files twice is a no-op. A different existing skill or symlink is left untouched; review it before replacing it. Remove only the installed **scout-qa** folder when you want to uninstall.

These paths follow the [official OpenAI skill guidance](https://learn.chatgpt.com/docs/build-skills) and [Claude Code skill guidance](https://code.claude.com/docs/en/skills). Client and managed-workspace discovery rules can vary. If a local skill does not appear, reload skills or restart the client.

## Install without the repository

[Download the skill ZIP](../../downloads/scout-qa.zip), its [SHA-256 file](../../downloads/scout-qa.zip.sha256), or inspect the [package manifest](../../skills/scout-qa/manifest.json). You can also [read SKILL.md directly](../../skills/scout-qa/SKILL.md) before installing.

The ZIP has one top-level **scout-qa** folder. Extract it and place that folder in your client's skills directory. On macOS/Linux, from the download directory:

~~~sh
shasum -a 256 -c scout-qa.zip.sha256
mkdir -p "$HOME/.agents/skills"
unzip -n scout-qa.zip -d "$HOME/.agents/skills"
~~~

For Claude Code, use **$HOME/.claude/skills** as the extraction destination. The **-n** option preserves existing files; it does not upgrade an older installation. Inspect and resolve any existing **scout-qa** folder first.

The checksum verifies download integrity. It is not a publisher signature; obtain the package and checksum from a documentation deployment you trust.

## Connect Spekios once

Follow [Connect your agent](../connect/) to add the HTTP connection URL and approve in your browser. The local Rust bridge remains an optional developer path. Spekios must already be running. A skill teaches an agent how to use the connection; installing instructions alone does not create it.

If MCP is unavailable, the skill's optional HTTP reference explains the same tool dispatcher. Configure the trusted API origin and token through your agent's local secret mechanism. Do not paste credentials into a prompt or embed them in the skill.

## Start working

In Codex:

~~~text
Use $scout-qa to explore https://your-app.example/.
Submit the URL, check progress when useful, and return a report
with expected versus actual behavior and evidence IDs.
~~~

In Claude Code:

~~~text
/scout-qa Explore https://your-app.example/ and report the findings.
~~~

Replace the example URL with an exact permitted origin reachable by Spekios's browser worker. To inspect existing work, give the saved job/run ID instead of asking for another exploration.

For a coding agent with repository access, add that it should investigate a selected finding and fix it if appropriate. The skill preserves your requested scope; asking for a report does not implicitly request code changes.

## What the agent learns

- Check **scout_status** before assuming a provider or target is available.
- Save a job UUID and reuse it on uncertain retries.
- Pull lightweight progress while continuing other authorized work.
- Follow every report continuation and handle snapshot changes.
- Use recorded locations, expectations, outcomes and evidence IDs to investigate.
- Send sign-in blockers to the human GUI handoff.
- Keep the permanent issue ID, submit a candidate with **scout_verify_fix** and report its recorded outcome with original/candidate evidence and usage.
- Cancel durable work explicitly when asked.

Agents can change an active exploration’s [testing focus](../../guides/testing-focus/) through the documented tools. The skill does not provide direct browser driving, source-code diagnosis, training approval or access to private sign-in material. Spekios continues using its configured provider's API access; installing a skill does not transfer a client subscription allowance.

Read the [full agent workflow](../workflow/) or [tool reference](../tools/) when you need more detail.
