# Agent instructions

## Branches

Do the work on a branch. Do not commit directly to `main`.

Most of the time, start that branch from an up-to-date `main`:

1. Fetch the latest `main`.
2. Check it out and make sure it matches the remote.
3. Create the working branch from that commit.

Use a short, descriptive branch name for the change. Keep unrelated work on its own branch.

## Commits

Do not add `Co-authored-by` trailers, or any other co-author attribution, to commit messages.

## Tests

Agents do not have to run the full test suite on every change. They should run every test that the change may have affected. If it is unclear whether a test is affected, run it.
