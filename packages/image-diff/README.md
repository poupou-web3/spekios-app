# Screenshot difference prototype

An independently runnable Node.js module and CLI for comparing two recorded screenshots. It preserves a change as small as one channel value at one pixel. This package does **not** execute browser actions, connect a model, upload evidence, or decide whether a change is a bug. Those integrations remain separate application work.

## Run

Requires Node.js 22 or newer. From this directory:

```sh
npm ci --ignore-scripts
npm test
node cli.mjs --before /path/before.png --after /path/after.png --out /path/new-result-directory --before-id cap-before --after-id cap-after
```

The output directory must not already exist; its parent must exist. Reruns refuse to overwrite any result. Inputs are opened for reading and never changed. Files are created with mode `0600` inside a directory with mode `0700`. The JSON printed on success includes the new `difference_id` and changed-pixel counts. Invalid input produces a nonzero exit status.

## Artifacts

| File | Meaning |
| --- | --- |
| `absolute-delta.png` | Each RGBA channel stores `abs(after − before)` in the overlapping area. Alpha is an actual alpha-channel difference, so this numeric artifact can look transparent in an image viewer. Decode its channels to inspect it. |
| `raw-mask.png` | Opaque binary mask: white for **any** nonzero RGBA difference, or a pixel added/removed by a dimension change; black otherwise. No threshold, denoising, or excluded region is applied. |
| `geometry-mask.png` | Written when dimensions differ. Green marks pixels present only in the after image; magenta marks pixels present only before. Black is overlap or outside both images. |
| `metadata.json` | Completion marker with capture IDs, original encoded-byte hashes, derivative hashes, dimensions, counts, bounding box, and `difference_version`. `bug_verdict` is explicitly null. |

The two screenshots are compared at their original top-left coordinates on a canvas of maximum width and height. No alignment, cropping, resizing, color correction, or gamma correction occurs. Added/removed geometry contributes to the raw mask but **does not** have a meaningful channel delta: the delta image is zero-filled outside the overlap. Source dimensions and the geometry mask distinguish these pixels from unchanged pixels. If one image is wider and the other taller, the canvas area outside *both* images is excluded from changed counts.

`changed_bbox` uses zero-based pixel coordinates and width/height extents; it is null for identical decoded pixels. `max_overlap_channel_delta` concerns the overlapping area only. Equal pixels can have different file hashes because PNG encoding or metadata differs. PNG metadata changes are not treated as pixel changes. The original bytes must remain stored as the authoritative evidence.

## API and capture lineage

```js
import { comparePng, compareFiles } from './index.mjs';

const result = comparePng(beforePngBuffer, afterPngBuffer, {
  beforeCaptureId: 'cap-before',
  afterCaptureId: 'cap-after',
});
// result: metadata, absoluteDeltaPng, rawMaskPng, geometryMaskPng

await compareFiles({
  beforePath: '/path/before.png',
  afterPath: '/path/after.png',
  outputDirectory: '/path/new-result-directory',
  beforeCaptureId: 'cap-before',
  afterCaptureId: 'cap-after',
});
```

Camel-case JavaScript parameters map to canonical `before_capture_id` / `after_capture_id` fields in JSON. Each source descriptor also contains its `capture_id`. IDs identify distinct capture occurrences, even if their PNG bytes are identical and share a content hash. The caller provides capture IDs; the module generates a fresh difference UUID. IDs accept 1–128 characters from letters, digits, `_`, `.`, `:`, and `-`, beginning with a letter or digit.

An eventual worker should persist both original capture references, then attach these derivatives and metadata to its action record in the evidence bucket. It must still run the semantic check when the mask is empty: no visual response can itself violate an expected outcome, and nonvisual state changes are possible. Timing, viewport, scroll, device scale, DOM/network signals, and pre-action expectations belong in that surrounding action record. Nothing here labels a model-training example as a confirmed bug.

## Explicit limits

- Accepts noninterlaced **8-bit RGB or RGBA PNG** browser screenshots. Other bit depths, indexed/grayscale PNGs, and APNG are rejected rather than silently rescaled or interpreted as a single frame. The 16-bit restriction avoids losing small channel changes during normalization.
- Each encoded input is capped at 16 MiB. Each input and the combined canvas are capped at 8,388,608 pixels and 8192 pixels per side. Headers and the canvas are checked before decoding. File reads are bounded even if a file grows after it is opened.
- PNG chunk structure, required ending, and decoder checksums are checked. Interlaced input is rejected because the selected decoder uses an unbounded inflate path for that format.
- Decoding/comparison is synchronous and intended for a worker process, not an API request thread. Memory and runtime are bounded by these limits, but this is not a sandbox for arbitrary hostile codecs.
- This is a pixel comparison, not perceptual matching. Fonts, animation, cursors, time, and scrolling can produce differences. Future prioritization or alignment must create separate derivatives; neither may replace the raw originals or raw mask.
- No connected-component ranking, cloud upload, crash-recovery protocol, video, or runtime integration is implemented here. A process crash can leave an incomplete output directory; consumers should require readable metadata plus verified derivative hashes, and retry into a fresh directory.

The pinned decoder is [pngjs 7.0.0](https://github.com/pngjs/pngjs). Tests cover exact equality, a one-value single-pixel change, alpha changes, invisible RGB changes, geometry changes, differing PNG encodings, corrupt/unsupported/oversized inputs, canvas limits, capture identity, RGB/RGBA equivalence, CLI output hashes, original preservation, and overwrite refusal.
