# Larchwood visual assessment evaluation

This pipeline freezes recorded actions from the [Larchwood shop](../../../apps/bug-lab/README.md)
and compares the same evidence assessed with full screenshots versus the production
overview/crop policy (`src/assessment-vision.ts`, `packages/image-diff/attention.mjs`).
It accepts paraphrased descriptions of the same failure. It never replays site
interactions or changes the original issue, evidence or review.

Commands: `snapshot`, `preview` (offline), `evaluate` (real model calls) and `report`;
`--help` prints their options. Run them inside the recorder image, where
PostgreSQL/S3/model-gateway credentials stay in the container environment. Do not copy
provider secrets into dataset files. The simplest way is `just larchwood-eval`, which
mounts `artifacts/evaluations` at `/evaluations`, runs as your user and sets
`RECORDER_SPOOL=/evaluations/spool`:

```sh
# SOURCE_RUN is a UUID from the intended user's public Larchwood recordings.
just larchwood-eval snapshot --origin https://larchwood-faulty.spekios.com \
  --run SOURCE_RUN --out /evaluations/corpus --variant faulty
```

To run it by hand, use `docker compose run --rm --no-deps --entrypoint ./node_modules/.bin/tsx recorder evaluation/larchwood.ts ...`,
bind a private host directory to `/evaluations`, set `RECORDER_SPOOL` to a private
writable path, and pass `--user "$(id -u):$(id -g)"` when that directory belongs to another UID.

## Freeze and inspect inputs

`snapshot` requires explicit run UUIDs and an exact source origin. It reads their
owner scope, rejects mixed owners, and excludes private sign-in actions, missing
evidence, tool errors and conflicting human/manifest labels. It verifies original
image hashes and freezes the screenshots, action expectations, diagnostics and
bounded earlier context. Partial runs can contribute fully recorded actions.

The planted bug/decoy manifest labels triggers independently of the original AI
verdict. Nth-action bugs are matched within each run. Unmatched observations stay
unlabelled; they cannot establish accuracy. Labels and original verdicts never
enter the assessor prompts. The snapshot records its manifest hash and checksum.

```sh
# Offline: no database writes, model requests or spend.
just larchwood-eval preview --dataset /evaluations/corpus/dataset.json \
  --out /evaluations/review --limit 10 --repeats 3 \
  --experiment EXPERIMENT_UUID --max-calls 120 --max-cost-usd 0.25
```

Review `review.md`, the original/cropped images and both prompt JSON files. Preview
and execution share the same input projection; opaque comparison/request IDs can
differ. The preview explicitly records zero model calls and pending authorization.

## Real paired evaluation

After authorization for the selected production evidence and model use:

```sh
just larchwood-eval evaluate --dataset /evaluations/corpus/dataset.json \
  --out /evaluations/results --experiment EXPERIMENT_UUID \
  --limit 10 --repeats 3 --max-calls 120 --max-cost-usd 0.25
```

It uses `muse-spark-1.3-contributor` through the configured demo connection in the
internal operator account. It imports cloned captures into
an evaluation run owned by that account. Customer allowances and original runs
are not used for billing or mutated. Normal gateway metering, byte verification,
immutable request IDs and credit limits apply. The model's Contributor data-use
policy applies to submitted content.

Selection rotates through defect/negative strata so repeated sightings of one
bug do not dominate. Three repeats alternate arm order. The source run's current
verdict is hidden. Models receive the same page context, frozen prediction and
original capture references. Only the visual presentation and its necessary
instructions differ. Crop eligibility and fallback follow production policy.

The pipeline records the first cropped response and final fallback response
separately. A text-only semantic judge sees the hidden reference and blinded
outputs, accepting equivalent descriptions and rejecting generic or different
suspicions. The judge uses the same model and can be wrong; inspect disagreements
in `report.md` and `experiment.json`. It is a grading aid, not human confirmation.

Usage includes every fallback. Full, optimized and judge costs/tokens/time are
reported separately. Missing provider cost remains unknown; demo ledger charges
are reported distinctly. The dollar guard leaves room for one maximum-size call
under the pinned Contributor tariff, and the gateway separately enforces its
counted-input lifetime ledger. Calls stop at the configured count/spend bound.

Requests are checkpointed before submission; rerunning the same experiment and
inputs reuses UUIDs. Changed policy/configuration requires a new experiment.
Failed/pending calls and incomplete evaluations cannot produce a quality pass.

## Read the result

- `summary.json`: detections of the same failure, raw suspicions, retention,
  losses/gains, false alarms, per-bug counts, crop-only results and usage.
- `report.md`: human-readable comparison and links to original actions.
- `experiment.json`: complete immutable configuration, per-call IDs/usage,
  first/final outputs, judgments and progress for resuming/review.

`pass_on_sample` requires retained baseline detections, no new false alarms,
known negatives, actual cropped positive cases and completed non-ambiguous
judging. Shared misses do not establish equivalence. Scripted gateways always
report `unverified_scripted_models`, including with `--allow-fixture` in tests.
This evaluates assessment on recorded examples, not exploration coverage or
population-wide model accuracy. Small negative sets and correlated repeats limit
what the sample can establish.

The GitHub **Vision evaluation contracts** workflow checks this machinery offline
on relevant PRs. It carries no credentials and performs no live inference. Real
model runs remain explicit, bounded jobs after reviewing their input snapshot.
