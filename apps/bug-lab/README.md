# Larchwood

A small home-goods shop that ships with 14 known bugs and 4 odd-looking but correct behaviours, for measuring what a Scout exploration finds. No dependencies; Node 22 or later.

```sh
node apps/bug-lab/server.mjs            # all bugs, http://127.0.0.1:4100
node apps/bug-lab/server.mjs --fixed    # every bug fixed
just bug-lab                            # in Compose: http://larchwood:8084 (bugs), :8085 (fixed)
just bug-lab-score RUN_ID               # score a run against bugs.json
```

- `bugs.json`: the bug list and how the scorer matches each bug to recorded actions
- `catalogue.mjs`, `pages.mjs`, `shop.mjs`, `server.mjs`: the shop
- `score.mjs`: scoring, used by `scripts/score-bug-lab.mjs`

Guide: [docs/exploration/bug-lab.md](../../docs/exploration/bug-lab.md).
