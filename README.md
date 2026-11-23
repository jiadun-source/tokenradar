# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: a dashboard that ranks pre-token DeFi protocols by implied value and shows a reader how to farm each one. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## The model (radar-2)

The implied value is calibrated from the market itself, not from a fixed multiple. The snapshot's live-token protocols already trade, so each one prices its category: the median market-cap-to-TVL ratio of the live protocols in a category is what the market pays for a unit of TVL there. A pre-token protocol is worth its TVL at its category's ratio, adjusted for seven-day growth and for how long it has run with no token. A category with fewer than three live comparables uses the all-category median. Wrapped, staked and bridged products are never ranked: their token already trades.

```
implied = round( tvl_usd x category_multiple
                 x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
                 x (0.6 + min(age_days, 1095) / 1095 x 0.4) )
```

The board covers the snapshot's whole watchlist (40 protocols at or above $50M TVL with no token on record) plus every other pre-token protocol the snapshot can rank — 198 rows in all — and sets the live-token protocols aside with their market caps shown.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` (Node 22, standard library only) reads the snapshot, writes the ranked board to `out/board.json` and the dashboard's data to `out/data.js`, copies `dashboard/` and `screenshots/` into `out/`, and writes `out/dossier.json`. The dashboard is a static page with no network: open `out/dashboard/index.html` in a browser.

---

<sub>Entered on [make.fun](https://make.fun/?ref=keen-koala-82-1094&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
