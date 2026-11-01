# Larchwood: a shop with known bugs

A clean run on a real site is ambiguous: the site may work, or Scout may have missed something. Larchwood is a small home-goods shop that ships with 14 bugs we planted and 4 behaviours that look odd but are correct. Exploring it and scoring the run shows what Scout found, what it tried but judged fine, what it never reached, and what it flagged that isn't a bug.

The code is in [apps/bug-lab](../../apps/bug-lab/). The bug list, [bugs.json](../../apps/bug-lab/bugs.json), is the ground truth: the shop, its tests and the scorer all read it.

## Run the shop

In Compose, next to the rest of the stack:

```sh
just bug-lab
```

| Build | Scout's browser uses | Preview on this machine |
|---|---|---|
| All bugs on | `http://larchwood:8084` | http://127.0.0.1:18084 |
| Every bug fixed | `http://larchwood:8085` | http://127.0.0.1:18085 |

Both origins are in the default `SCOUT_ALLOWED_ORIGINS`. If your `.env` sets that variable, add them to it and run `docker compose up -d api browser-worker`.

On this computer, without Docker (needs Node 22):

```sh
just bug-lab-local                 # all bugs, port 4100
just bug-lab-local 4100 --fixed    # every bug fixed
just bug-lab-local 4100 --bugs price-sort,cart-total
just bug-lab-local 4100 --pair     # bugs on 4100, fixed on 4101
```

Scout's browser runs in Docker, where `localhost` is its own container. Give it `http://host.docker.internal:4100` and add that origin to `SCOUT_ALLOWED_ORIGINS`. The workspace's URL field suggests this address when you type a `localhost` one.

## Explore and score

1. Turn off App memory in Settings, or forget the Larchwood origin under **Settings → App memory**. Otherwise a second run skips controls the first one tried, and the two scores don't compare.
2. Explore `http://larchwood:8084`. Several bugs need a few steps (add to cart, then change the quantity), so give the run room: an action limit of about 100 is a reasonable start. The mobile-only bug needs a run with the **Mobile** screen size.
3. Score one or more runs:

```sh
just bug-lab-score RUN_ID [RUN_ID...]
node scripts/score-bug-lab.mjs RUN_ID --json
```

The scorer reads runs through the API with `SCOUT_TOKEN`, or `SCOUT_API_TOKEN` from this checkout's `.env`. Each bug lands in one group:

| Result | Meaning |
|---|---|
| found | An action that triggers the bug was assessed as suspect |
| tried, judged fine | Scout triggered the bug and at least once assessed it as fine. A judgement miss |
| inconclusive | Scout triggered it and no assessment was conclusive |
| never tried | No action triggers the bug. A coverage miss |
| n/a | The bug needs another screen size than the run used |

Suspects on the odd-but-correct cases are **false alarms**. Other suspects are listed for a person to check: they can be false alarms or real problems nobody planted. Model answers vary, so compare three runs or more rather than one.

### How actions are matched

Each entry's `match` names the page before and after the action (regular expressions on path and query, from the recorded screenshots' URLs) and the control Scout used (role and name). `every: 2` means only every second matching action triggers it, for the add that fails every second time.

The scorer credits the action that triggers a bug. If Scout notices the problem one action later, for example the cart total after leaving the cart, that is counted as a miss. Matching depends on control names: the browser test below fails if a trigger control is renamed or stops being usable, so the two stay in step.

## The bugs

| Type | Bug | Trigger |
|---|---|---|
| Easy | Save to wishlist does nothing | Product page, "Save to wishlist" |
| Easy | Shipping & returns link leads to a 404 | Footer link |
| Easy | Order tracking returns a bare HTTP 500 | "Find my order" on Track order |
| Easy | One help question never opens; console TypeError | "Can I exchange an item?" on Help |
| Wrong data | Search ignores what you type | Any search on Shop |
| Wrong data | "In stock only" still lists sold-out products | The Shop checkbox |
| Wrong data | Price sort orders the numbers as text | "Sort by" price, either direction |
| Wrong data | Cart quantity change leaves the total unchanged | "Increase/Decrease quantity of …" in the cart |
| Visual | Reviews show "Invalid Date" and "undefined / 5" | The "Reviews (n)" tab |
| Visual | Sale banner covers the Deals title | Opening Deals |
| Visual | The size guide can't be closed | "Size guide", then "Close" |
| Hard | "Back to results" forgets search, filters and page | Filter, open a product, go back |
| Hard | Every second "Add to cart" in a session fails with HTTP 503 | A second add; a fresh browser's first add works, so a single-add replay won't reproduce it |
| Hard | The mobile menu opens off-screen | "Menu" at mobile width |

Correct but odd-looking: sold-out products with a disabled "Sold out" button, the promo code field refusing anything but WELCOME10, the empty cart, and a free product (Fabric Swatch Set, €0, free delivery).

None of the bugs sit behind words Scout refuses to click (sign in, checkout, delete, remove, reset, subscribe…) or behind a POST form. The only form submissions are GET search forms.

## Fix verification

The fixed build is the same shop on another origin. After triaging Larchwood findings as bugs, recheck them against it:

```sh
node scripts/scout-recheck.mjs --candidate http://larchwood:8085 --source http://larchwood:8084
```

`--source` is needed because a recheck otherwise looks for issues on the candidate's own origin. Fixed bugs should come back resolved. The every-second-add failure may come back inconclusive, because a fresh browser's first add works in both builds.

## Adding or changing a bug

1. Add the entry to `bugs.json` with its `match`, and the switch in [pages.mjs](../../apps/bug-lab/pages.mjs) or [shop.mjs](../../apps/bug-lab/shop.mjs). The server decides which code a page gets: nothing sent to the browser may name a bug or say whether it is on.
2. Put the bug on a control Scout can use: a link, button, search box, select, checkbox or radio with a unique name on its page, no `role` attribute that differs from the element's own, no number inputs, and no blocked word in its name or link.
3. Add its check to [bug-lab.test.ts](../../packages/browser-runtime/test/bug-lab.test.ts): it must show with the bug on and be gone with it off.

## Tests

```sh
just bug-lab-test
```

This runs the HTTP and scoring tests (`node --test apps/bug-lab/test/*.test.mjs`) and the Chromium test in the recorder image. The HTTP tests also check that the fixed build has no dead links, that the buggy build's only dead link is the planted one, and that no page, URL or header contains a giveaway word or a bug ID. The Chromium test proves every bug and correct case in a real browser, and runs Scout's own control observer on the shop to check that every trigger is a usable, unambiguous control.
