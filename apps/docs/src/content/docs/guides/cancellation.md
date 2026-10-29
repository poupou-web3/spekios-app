---
{
  "title": "Stop work and preserve evidence",
  "description": "Understand explicit cancellation for Scout jobs, active runs and automatic reproduction batches, including retained evidence and late provider usage.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 5
  }
}
---
Use an explicit cancellation command when you want durable browser work to stop. Closing a tab, disconnecting an MCP client or aborting an HTTP request does not cancel the job.

## Choose the scope

- **Job:** stop a queued or active job.
- **Run:** stop the selected browser execution.
- **Automatic checks:** stop the source run’s bounded recheck batch, including checks scheduled after the parent run finishes.

In MCP use **scout_cancel_work** with **kind** and **id**. The REST cancellation endpoints are listed in [the jobs API](../../api/jobs/).

## What happens next

Cancellation is durable and acknowledged by the worker. In-flight operations can take time to settle. Inspect progress and the recorded acknowledgement before treating the browser as stopped.

Recorded actions, captures, model attempts and cancellation events remain available. The report distinguishes cancellation from a passing result or an app bug.

## Model usage after stopping

The gateway may receive a late provider result or usage record after cancellation. That usage is retained. Stopping a browser does not imply an already dispatched provider request was never consumed.

## Process interruption

Recovery records interruption and retained evidence. It does not automatically replay an uncertain click, form submission or private login input. Start a new job when you are ready to test again.

Stopping Compose preserves volumes. Removing volumes deletes data and is not a cancellation mechanism.
