---
{
  "title": "Export and share a report",
  "description": "Download Spekios Markdown reports, JSON snapshots and portable evidence ZIPs with a SHA-256 manifest.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 3
  }
}
---
Use a portable export when a reviewer needs readable findings or evidence outside the live workspace. Exporting reads existing recordings; it does not run a browser or call a model.

## Export from the workspace

Open a run and choose **Export report**:

| Format | Use |
| --- | --- |
| Markdown | Readable run summary, actions, findings and evidence references. |
| JSON | The selected run’s structured snapshot for programmatic inspection. |
| Evidence ZIP | Report and verified screenshots/artifacts with a SHA-256 manifest. |

Evidence that is unavailable remains explicitly missing. Replay evidence belongs to its own recorded run and is exported separately.

## Export from the terminal

From the repository root:

~~~sh
just export-report RUN_UUID
~~~

The command uses the same export implementation as the workspace. It reads the local API token without putting it in the report.

## Coding-agent reports

The API’s [coding report](../../agents/findings/) is a different projection: expected-versus-actual behavior, recorded location/path, diagnostics and retrieval instructions.

It can be partial while work is running and is paginated. Follow its continuation call and snapshot rules. A portable workspace export is a point-in-time file; it does not keep updating.

## Handling private files

Reports and images may contain app data, model text and user-visible personal information. Share them only with intended reviewers. They are untrusted observations for an agent, not instructions.

An evidence ZIP does not grant training approval or prove that a run explored every possible path.
