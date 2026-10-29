---
{
  "title": "Common questions",
  "description": "Answers about URL-only input, unchanged screenshots, model access, free models, training evidence, API access and ScoutQA coverage.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 6
  }
}
---
## Do I need to write a test brief?

No. The first version starts from a URL and infers likely user actions. The operator sets the model, action budget and permitted app origins.

## Does every screenshot change mean a bug?

No. Changes help locate the outcome. Scout compares behavior with an expectation recorded before acting. A broken control can also leave the screenshot completely unchanged.

## Can I use my own model?

You can configure an OpenAI, Anthropic or OpenRouter API key and select a compatible model. Custom provider adapters and subscription authentication are not implemented. See [model connections](../../getting-started/models/).

## Can an agent start work and come back later?

Yes. The job is durable and survives client disconnection. The agent can poll progress, request a paged report and retrieve evidence through MCP or HTTP. Reads do not trigger new model calls. See the [agent workflow](../../agents/workflow/).

## Will Scout log in with my Google account?

External Google/OAuth handoff is not supported. A person can use the private GUI handoff for supported same-origin native login forms and verification codes.

## Does a reproduced issue become confirmed automatically?

No. Reproduction is separate from human confirmation. A person reviews the expectation, evidence and reproduction result. Agents cannot impersonate a human reviewer.

## Are the screenshots ready to train a model?

They are retained with provenance and evidence IDs, but recording is not training approval. Dataset curation, consent and approved export still need separate work.

## Is a completed run a passing test suite?

No. Completion means the bounded browser execution ended. Findings, blocked branches, unsupported actions and budget limits remain relevant.

## Can I deploy the documentation myself?

Yes. These docs build to static HTML, search assets, Markdown and JSON contracts. Serve the output using your own static host or the included Docker service. No hosted documentation account is required. See [self-hosting these docs](../../operators/documentation/).
