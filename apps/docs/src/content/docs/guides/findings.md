---
{
  "title": "Review and reproduce a finding",
  "description": "Inspect a Scout suspicion, independently replay its recorded path and record an evidence-backed human confirmation or dismissal.",
  "reviewed": "2026-10-28",
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

Choose reproduction for a completed suspect. Scout starts a fresh browser, restores the original saved sign-in context when available and follows the recorded prerequisite path to the selected action.

The replay preserves the original typed parameters, viewport and expected result. Changed preconditions leave an inconclusive result; the worker does not invent replacement inputs.

There is one saved reproduction attempt per source candidate. Repeated requests reuse it. A reproduced suspicion remains distinct from human confirmation.

## Record a human disposition

A person can choose **confirmed**, **dismissed** or **needs review**, with a rationale. Confirmation also requires an expectation basis, severity and the required verified reproduction evidence.

Reviews are append-only and use optimistic revisions. If someone has already changed the review, refresh it and reconsider the new state before submitting.

The tool/API agent interface can read review status. It cannot submit a human review or approve evidence for training.

## Optional automatic rechecks

Enable automatic rechecks when starting exploration or in saved defaults. They are off by default. The default batch reserves up to two cases and twelve total replay actions, including prerequisites. Configurable maxima are three cases and 100 replay actions. A single replay can be up to 50 actions long, so suspects found late in a long run need a larger total.

Reservations remain recorded. Cancelled or interrupted checks are not automatically retried. **Stop automatic checks** stops the source run’s recheck batch even after exploration finishes.

## After a code fix

Run a new exploration with a new job UUID against the updated app. A historical reproduction describes an earlier attempt and cannot validate the deployed fix.
