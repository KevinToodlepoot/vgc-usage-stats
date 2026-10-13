# vgc-usage-stats

A generator that turns one of Smogon's monthly Pokémon Showdown usage stats files
(the `chaos/` JSON) for a VGC format into a spread-level dataset on disk: every
species, every reported spread as nature plus stat points plus weight, with
optional derived final stats and per-species summaries.

This repo holds code, schemas and fixtures only. It commits no data and runs on
no schedule. Run it for the month, format and cutoff you want, keep the output
where you like, and record the generation manifest's source hash and this repo's
commit if you need to reproduce the result later.

```
vgc-usage-stats generate --month 2026-09 \
  --format gen9championsvgc2026regmcbo3 --cutoff 1760 --out ./usage
```

The specification, including the output contract and acceptance tests, is in
[`docs/SPEC.md`](docs/SPEC.md).

## Data source and license

Usage statistics are published by Smogon at <https://www.smogon.com/stats/>. The
source code in this repository is MIT-licensed (see `LICENSE`); that license does
not cover Smogon's data or anything derived from it, which remain subject to
Smogon's terms.
