# Larchwood

A small home-goods shop that ships with 14 known bugs and 4 odd-looking but correct behaviours (decoys), for measuring what a Spekios exploration finds. Plain Node.js (22 or later), no dependencies.

```sh
node apps/bug-lab/server.mjs                 # all bugs, http://127.0.0.1:4100
node apps/bug-lab/server.mjs --fixed         # every bug fixed
node apps/bug-lab/server.mjs --bugs id,id    # only these bugs
node apps/bug-lab/server.mjs --pair          # bugs on --port, fixed shop on --port + 1
just bug-lab-local                           # same as the first line; extra flags pass through
just bug-lab                                 # Compose `larchwood` service: http://larchwood:8084 (bugs), :8085 (fixed)
just bug-lab-score RUN_ID [RUN_ID...]        # found, missed and never-tried bugs for recorded runs
just bug-lab-test                            # shop and scorer tests, then a Chromium check that every bug is real
```

Inside Compose, Spekios's browser reaches the shop at `http://larchwood:8084` and `:8085` (both in the default `SCOUT_ALLOWED_ORIGINS`); on the host they are 127.0.0.1:18084 and :18085.

- `bugs.json`: the bugs and decoys, and how the scorer matches each one to recorded actions
- `catalogue.mjs`, `pages.mjs`, `shop.mjs`, `server.mjs`: the shop
- `score.mjs`: scoring, used by `scripts/score-bug-lab.mjs` and the [visual assessment evaluation](../../packages/browser-runtime/evaluation/README.md)
- `test/`: `node --test` suites for the shop and scorer

Guide: [docs/exploration/bug-lab.md](../../docs/exploration/bug-lab.md).

The production deployment can also publish both variants as separate HTTPS sites (`compose.demos.yaml`): `https://larchwood.spekios.com` (fixed) and `https://larchwood-faulty.spekios.com` (bugs on). Separate hostnames keep cookies, carts and Spekios histories apart. See [public demonstration shops](../../infra/deploy/README.md#public-demonstration-shops).
