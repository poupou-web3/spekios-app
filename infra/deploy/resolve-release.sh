#!/usr/bin/env bash
# Resolve a prod push to its matching main commit using the fetched histories.
# Checkout and playbook stay on main. Only this immutable SHA is archived.
set -euo pipefail
event=${1:?event required}
ref=${2:-}
if [[ "$event" == push ]]; then
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid push commit SHA.' >&2; exit 1; }
  source_sha=$(git merge-base origin/main "$ref")
  if [[ "$(git rev-parse "$ref^{tree}")" != "$(git rev-parse "$source_sha^{tree}")" ]]; then
    echo 'Release rejected: merge main into prod; production code must match a main commit.' >&2
    exit 1
  fi
elif [[ "$event" == workflow_dispatch ]]; then
  if [[ -n "$ref" ]]; then
    [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]] || { echo 'Rollback ref must be a commit SHA on main.' >&2; exit 1; }
  else
    ref=origin/main
  fi
  source_sha=$(git rev-parse --verify "$ref^{commit}")
  git merge-base --is-ancestor "$source_sha" origin/main || { echo 'Rollback commit must be on main.' >&2; exit 1; }
else
  echo 'Unsupported deployment event.' >&2
  exit 1
fi
printf '%s\n' "$source_sha"
