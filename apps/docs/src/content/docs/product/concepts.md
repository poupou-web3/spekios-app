---
{
  "title": "Runs, actions and evidence",
  "description": "Learn Spekios’s core data model: jobs, runs, states, actions, captures, artifacts, findings and independent reproductions.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 2
  }
}
---
Spekios keeps commands, browser observations and review decisions as distinct records. Their IDs let a person or agent trace a report back to the action and bytes that support it.

| Record | Meaning |
| --- | --- |
| Job | A durable request to explore a URL, reproduce a suspected action or verify a fix on a candidate deployment. |
| Run | One recorded browser execution, with configuration and lifecycle. |
| State | An observed page state, including visible controls, input state and authentication context. |
| Action | A typed browser operation with a frozen prediction, exact parameters and an assessment. |
| Capture | A screenshot with a unique UUID, SHA-256, byte length and private object reference. |
| Artifact | A manifest, image-difference mask, diagnostics or another recorded evidence object. |
| Finding | An original suspected problem plus its independent reproduction and human-review overlays. |
| Issue | A permanent ID for a suspected problem, shared by matching findings across runs, with its triage and fix-verification history. |
| Settings revision | An append-only version of nonsecret defaults, frozen when a job is admitted. |

## Job status and run lifecycle

The queue and browser execution have separate statuses. A job can fail during delivery after its browser run has already completed. Reports preserve both facts rather than converting a storage failure into an application bug.

Use [progress](../../api/progress-reports/) to understand the current phase. An interrupted execution is not silently resumed by replaying uncertain actions; **Continue exploration** starts a new run from the recorded graph.

## Expected versus actual

A prediction states what should happen before the action is dispatched. The subsequent assessment compares that prediction with fresh evidence. This preserves the difference between an expectation and a retrospective explanation.

The expectation is an AI inference. A reviewer or coding agent still needs to check whether it matches the product’s intended behavior.

## Evidence identity

Reference captures and artifacts by their recorded UUIDs. Two references to the same image content do not grant access across runs. Retrieval verifies run binding, ownership, hash and length.

See [evidence and training boundaries](../evidence/) and [API evidence retrieval](../../api/evidence/).
