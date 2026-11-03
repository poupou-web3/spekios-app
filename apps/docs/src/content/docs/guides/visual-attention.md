---
{"title":"Understand visual focus and image crops","description":"How Spekios focuses assessments on changed regions while retaining page context, original evidence and full-screen fallbacks.","reviewed":"2026-11-03","sidebar":{"order":6}}
---
Spekios compares the screenshots before and after each action. The exact difference mask preserves every changed pixel, including a change of one channel value at one pixel. White means changed; black means unchanged. A difference locates a change and does not decide whether it is a bug.

## Focus regions

Changed pixels are grouped into nearby regions. Each region, including its surrounding padding, covers at most **25% of the original screenshot area**. A widespread change is split across regions. If there are too many regions, the metadata explicitly records incomplete focus coverage and the assessment uses full screenshots.

The raw mask and both original screenshots remain unchanged. Focus regions are additional attention hints, not filtered evidence.

## What the assessment model sees

For a localized, settled action on the same page, Spekios can send two smaller image sheets: before and after. Each contains a reduced whole-page overview followed by native-resolution detail crops. The interacted control is included even when that control did not change. Panel coordinates describe both their source location and their position on the sheet.

The model is told to inspect the crops first, then check the expected result, page text, controls, diagnostics and overview. It must request full context when the expected result cannot be located or important detail is unreadable. Suspected bugs, uncertain results and context requests receive a fresh assessment on the original full screenshots.

Full screenshots are used directly for navigation, page/geometry changes, zero visual change, broad or fragmented changes, uneconomic crops, unsettled actions and replay/fix verification. An empty mask still requires a semantic assessment: a missing response can violate the expectation.

In the action inspector, **AI before** and **AI after** show the actual reduced image sheets when present. **Before**, **After** and **Difference mask** retain the original evidence. A full-screen reassessment is identified separately.

## Website context

Every assessment retains page titles, URLs, bounded visible text and controls, the action's predicted result, recent history and timing/network diagnostics. With app memory enabled, it also receives bounded observations from earlier runs. Exploration builds a map of observed pages and transitions as it discovers the site.

These observations describe what the app did. They do not establish what it should do. Product expectations remain hypotheses unless validated by requirements or human review. Crop preparation adds no separate model call to summarize the website.

## Tokens and latency

Reduced image dimensions can lower image input tokens, depending on the model's image accounting. For example, [Anthropic documents image-resolution token costs](https://platform.claude.com/docs/en/build-with-claude/vision). Additional crops and full-screen retries also have a cost. Spekios records source and transmitted pixel counts, but pixel reduction is not a token-saving estimate. Provider-reported input/output tokens and cost remain authoritative; missing usage stays unknown.

Cropping does not directly reduce response tokens or change the configured output-token limit. Full screenshots are still retained for evidence and verification.
