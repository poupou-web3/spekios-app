---
{
  "title": "Common questions",
  "description": "Answers about URL-only input, unchanged screenshots, model access, free models, training evidence, API access and Spekios coverage.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 6
  }
}
---
## Do I need to write a test brief?

No. Spekios starts from a URL and infers likely user actions. You choose the model in **Settings** and can set optional limits. A [testing focus](../../guides/testing-focus/) can steer a running exploration, but it is never required.

## Does every screenshot change mean a bug?

No. Changes help locate the outcome. Spekios compares behavior with an expectation recorded before acting. A broken control can also leave the screenshot completely unchanged.

## Can I use my own model?

You can add OpenAI, Anthropic, OpenRouter or Meta AI API keys and choose any compatible model ID from those providers. Custom provider adapters and subscription authentication are not implemented. See [model connections](../../getting-started/models/).

## Can an agent start work and come back later?

Yes. The job is durable and survives client disconnection. The agent can poll progress, request a paged report and retrieve evidence through MCP or HTTP. Reads do not trigger new model calls. See the [agent workflow](../../agents/workflow/).

## Will Spekios log in with my Google account?

External Google/OAuth handoff is not supported. A person can use the private GUI handoff for supported same-origin native login forms and verification codes.

## Does a reproduced issue become confirmed automatically?

No. Reproduction is separate from human confirmation. A person reviews the expectation, evidence and reproduction result. Agents cannot impersonate a human reviewer.

## Are the screenshots ready to train a model?

They are retained with provenance and evidence IDs, but recording is not training approval. Dataset curation, consent and approved export still need separate work.

## Is a completed run a passing test suite?

No. Completion means the browser execution ended. Findings, blocked branches, unsupported actions and reached limits remain relevant.

## Can I deploy the documentation myself?

Yes. These docs build to static HTML, search assets, Markdown and JSON contracts. Serve the output using your own static host or the included Docker service. No hosted documentation account is required. See [self-hosting these docs](../../operators/documentation/).
