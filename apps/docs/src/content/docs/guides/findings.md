---
{
  "title": "Review and reproduce a finding",
  "description": "Inspect a Spekios suspicion, independently replay its recorded path and record an evidence-backed human confirmation or dismissal.",
  "reviewed": "2026-10-31",
  "sidebar": {
    "order": 2
  }
}
---
A suspected bug is an observation to investigate. Check the intended behavior, the recorded path and evidence before turning it into a repair task.

## Review the original action

Open the candidate and compare its frozen expectation with the app’s actual requirements. Inspect before/after captures, masks, completion samples and redacted diagnostics. A text label or an image change alone may be insufficient.

The report may also show normal changes, diagnostic signals, inconclusive checks and execution problems. These categories have different meanings.

## Request fresh reproduction

Choose reproduction for a completed suspect. Spekios starts a fresh browser, restores the original saved sign-in context when available and follows the recorded prerequisite path to the selected action.

The replay preserves the original typed parameters, viewport and expected result. Changed preconditions leave an inconclusive result; the worker does not invent replacement inputs.

There is one saved reproduction attempt per source candidate. Repeated requests reuse it. A reproduced suspicion remains distinct from human confirmation.

## Record a human disposition

A person can choose **confirmed**, **dismissed** or **needs review**, with a rationale. Confirmation also requires an expectation basis, severity and the required verified reproduction evidence.

Reviews are append-only and use optimistic revisions. If someone has already changed the review, refresh it and reconsider the new state before submitting.

The tool/API agent interface can read review status. It cannot submit a human review or approve evidence for training.

## Decide what it is

On the issues page, triage each issue as a **bug**, **intended behavior**, a **duplicate** or **needs review**. Triage decides what Spekios does next: bugs are rechecked after deploys, and later runs that reach the same page and control are labelled with the decision. Agents can triage too, but cannot replace a person's decision. See [triage and rechecks](../triage/).

A human review labels one action's evidence; triage decides what the issue is. Both are kept.

## Optional automatic rechecks

Enable automatic rechecks when starting exploration or in saved defaults. They are off by default. The default batch reserves up to two cases and twelve total replay actions, including prerequisites. Configurable maxima are three cases and 100 replay actions. A single replay can be up to 50 actions long, so suspects found late in a long run need a larger total.

Reservations remain recorded. Cancelled or interrupted checks are not automatically retried. **Stop automatic checks** stops the source run’s recheck batch even after exploration finishes.

## After a code fix

Run a new exploration with a new job UUID against the updated app, verify the issue on the new deployment, or [recheck every open issue at once](../triage/#recheck-after-a-deploy). A historical reproduction describes an earlier attempt and cannot validate the deployed fix.
