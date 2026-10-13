# vgc-usage-stats

A generator that turns one of Smogon's monthly Pokémon Showdown usage stats files
(the `chaos/` JSON) for a VGC format into a spread-level dataset on disk: every
species, every reported spread as nature plus stat points plus weight, with
optional derived final stats and per-species summaries.

This repo holds code, schemas and fixtures only. It commits no data and runs on
no schedule. Run it for the month, format and cutoff you want, keep the output
where you like, and record the generation manifest's source hash and this repo's
commit if you need to reproduce the result later.

The specification, including the output contract and acceptance tests, is in
[`docs/SPEC.md`](docs/SPEC.md). The output schemas are in [`schemas/`](schemas/).

## Install

Requires Node 22.18 or newer. There is no build step; the TypeScript source runs
directly.

```
git clone https://github.com/KevinToodlepoot/vgc-usage-stats
cd vgc-usage-stats
npm ci
```

`npm ci` also builds the pinned `pokemon-showdown` checkout inside
`node_modules` (a one-second esbuild run), which `--stats` needs. The core path
never loads it.

## Usage

See what Smogon has for a month:

```
node bin/vgc-usage-stats.js list --month 2026-09 --filter champions
```

Generate one format at one cutoff:

```
node bin/vgc-usage-stats.js generate --month 2026-09 \
  --format gen9championsvgc2026regmcbo3 --cutoff 1760 --out ./usage
```

Every `--format` × `--cutoff` pair is generated; both flags repeat. Options:

| Flag | Effect |
| --- | --- |
| `--summary` | also write `summary.json` (nature shares, concentration, stat distributions) |
| `--stats` | also derive final stats with the pinned pokemon-showdown; one `--format` per run |
| `--min-share X` | drop spreads below this share of the species' weight (default `0`) |
| `--raw FILE` | read a local chaos file (plain or `.gz`) instead of fetching |
| `--cache DIR` | where fetched files are kept (default `~/.cache/vgc-usage-stats`) |
| `--refresh` | ask Smogon again even when the cache has the file |

Output lands in `<out>/<month>/<format>-<cutoff>/` as `manifest.json`,
`index.json`, `spreads/<speciesid>.json` and optionally `summary.json`. A failed
run writes nothing and exits non-zero: `2` bad arguments, `3` not found at
Smogon, `4` fetch failed, `5` validation failed.

Fetched files are cached gzipped with a sidecar recording the URL, ETag,
Last-Modified and hash. Smogon honours `If-None-Match`, so `--refresh` is cheap
when nothing changed. A cache entry can be passed straight to `--raw` for an
offline rerun.

### What a run costs

Measured on 2026-09 from the cache, Apple Silicon, no floor:

| File | Species | Spreads | Time | Output (with `--summary --stats`) |
| --- | --- | --- | --- | --- |
| regmcbo3-1760 (5.6 MB raw) | 191 | 98,757 | ~1 s | 22 MB |
| regmc-1500 (18.7 MB raw) | 316 | 313,180 | 1.1 s core, 2.5 s with `--summary --stats` | 111 MB (72 MB spreads, 39 MB summary) |

`--min-share 0.001` on regmc-1500 drops 91% of spreads and brings the output to
5.4 MB. The floor and what it removed are recorded in every spreads file.

### Reproducing a generation

`manifest.json` records the source hash, this repo's commit, the options and the
pokemon-showdown commit. The same raw bytes, commit and options produce
byte-identical output; only `manifest.json` carries timestamps. Keep the cached
`.json.gz` (or your own copy) and rerun with `--raw` to regenerate without
depending on Smogon still serving the file.

## Library

TypeScript consumers can import the same steps instead of shelling out:

```ts
import { fetchChaos, generate, loadStatsDeriver } from "vgc-usage-stats";

const target = { month: "2026-09", format: "gen9championsvgc2026regmcbo3", cutoff: 1760 };
const { bytes, source } = await fetchChaos(target);
const { dir, manifest } = await generate({
  target, raw: bytes, source, out: "./usage",
  summary: true,
  stats: await loadStatsDeriver(target.format),
});
```

`parseChaos`, `summarizeSpecies`, `buildSpreadsFile`, `validate` and friends are
exported too; see `src/index.ts`.

## Development

```
npm run check     # typecheck + tests
npm test          # tests only (node --test)
```

Tests run offline: a local HTTP server stands in for Smogon, and the parity test
for derived stats builds real Champions battles with the pinned Showdown.

## Data source and license

Usage statistics are published by Smogon at <https://www.smogon.com/stats/>. The
source code in this repository is MIT-licensed (see `LICENSE`); that license does
not cover Smogon's data or anything derived from it, which remain subject to
Smogon's terms.
