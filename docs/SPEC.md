# vgc-usage-stats — Specification

Status: **Draft** (revised 2026-10-13; first draft 2026-10-06). This document is
the source of truth for what the repo does. The implementation plan is built from
this file; change the spec first, then the code.

**2026-10-13 revision:** the repo is a **generator**, not a dataset. It no longer
commits derived data, runs on a schedule, or archives raw files. A consumer runs
it on demand for a month, format and cutoff, and keeps the output wherever it
wants. See §12 for what changed and why.

## 1. Purpose and consumers

Take one of Smogon's monthly Pokémon Showdown usage stats files for a VGC format
and turn it into a spread-level dataset on disk: for every species, every
reported spread as nature plus stat points plus weight, with optional derived
stats and summaries.

This is a standalone public tool. It is not built around any particular
downstream project; consumers adapt to its published output contract.

Consumers:

- **Downstream tools in any language** (TypeScript, Python, etc.), such as set
  inference, opponent modelling or damage-calc tooling. They run the CLI (or call
  the library from TypeScript) and read the JSON it writes. The output contract is
  language-neutral JSON with published JSON Schemas (§4.6).
- **People** exploring a month's spreads locally, through `summary.json`.

The expected consumer pattern is **generate once, then lock**: a consumer runs the
generator when it wants a new month, records the generation manifest's source
hash and this repo's commit alongside whatever it derives, and never runs the
generator at its own runtime. The generator is designed so that this is enough to
reproduce a result later (§6.5).

## 2. Source data (Smogon)

Root: `https://www.smogon.com/stats/`. Months are `YYYY-MM/` directories, from
2014-11 to the present. A few directories carry suffixes (`-DLC1`, `-H1`/`-H2`),
and none of them matter for Champions formats. A new month appears around the 1st
of the following month (2026-09 was published 2026-10-01).

Each month contains top-level usage `.txt` files plus `chaos/`, `moveset/`,
`leads/`, `metagame/` and `monotype/`. File names are
`<showdown-format-id>-<cutoff>.<ext>`.

**This repo reads `chaos/<format>-<cutoff>.json` only.** The `moveset/` text files
truncate spreads to the top ~6 plus an "Other" bucket (84% "Other" for Rillaboom
in regmc-1760), so they are never used, not even as a fallback.

### 2.1 Chaos JSON shape (as observed)

```jsonc
{
  "info": {
    "metagame": "gen9championsvgc2026regmc",
    "cutoff": 1760,
    "cutoff deviation": 0,
    "team type": null,
    "number of battles": 1631943
  },
  "data": {
    "Rillaboom": {
      "Raw count": 1410840,
      "Viability Ceiling": [58135, 84, 74, 62],
      "Abilities": { "grassysurge": 5995.33, ... },
      "Items":     { "miracleseed": ..., ... },
      "Spreads":   { "Adamant:32/32/0/0/2/0": 265.09, ... },  // Nature:HP/Atk/Def/SpA/SpD/Spe
      "Moves": { ... }, "Tera Types": { "nothing": ... }, "Happiness": { "255": ... },
      "Teammates": { ... }, "Checks and Counters": { ... },
      "usage": 0.4659939
    }
  }
}
```

In Champions formats the six spread numbers are **stat points (SP)**, not EVs:
0–32 per stat and at most 66 in total.

## 3. Inputs

The generator takes its inputs on the command line (§6). There is no committed
registry of regulations or formats; any format id Smogon publishes a chaos file
for is accepted.

- `--month YYYY-MM` (required).
- `--format <showdown-format-id>` (required, repeatable), e.g.
  `gen9championsvgc2026regmcbo3`.
- `--cutoff <n>` (required, repeatable), e.g. `0 1500 1630 1760`. Every
  format × cutoff pair is generated.
- `--raw <path>`: read a local chaos file instead of fetching (one format × cutoff
  per invocation). Used for offline reruns and tests.
- `--out <dir>` (required): the target directory (§4.1).
- `--cache <dir>`: where fetched raw files are kept (§6.3). Defaults to
  `~/.cache/vgc-usage-stats`.
- `--stats`: also derive final stats with the pinned pokemon-showdown (§5.2).
- `--summary`: also write `summary.json` (§4.3).
- `--min-share <x>`: drop spreads below this share of the species' total weight
  (§4.4). Default `0` (keep everything).

Regulations can overlap: 2026-06 had both regma and regmb chaos files. That is the
consumer's concern; the generator processes whatever it is asked for.

## 4. Outputs

### 4.1 Layout

Everything is written under `--out`:

```
<out>/
  <YYYY-MM>/
    <format>-<cutoff>/                    # e.g. gen9championsvgc2026regmcbo3-1760/
      manifest.json                       # §4.5, one per generation
      index.json                          # §4.2
      summary.json                        # §4.3, only with --summary
      spreads/
        <speciesid>.json                  # §4.4, one per species
```

`<speciesid>` is the Showdown ID (`toID(name)`): lowercase, alphanumerics only.
For example `Salamence-Mega` becomes `salamencemega`. This needs no Dex; it is a
string transform of the chaos key.

Rerunning into the same `--out` overwrites the format × cutoff directory. Nothing
is written if the run fails (§5.4): outputs go to a temporary sibling directory
and are moved into place at the end.

### 4.2 `index.json`

One per format/cutoff/month. Small; it lets consumers discover what exists.

- `schema_version`, `month`, `format`, `cutoff`
- `source`: Smogon URL (or the `--raw` path), `sha256` and `bytes` of the raw
  file as read
- `info`: the chaos `info` block, passed through unchanged
- `species`: an array of `{ name, id, file, total_weight, raw_count, usage,
  n_spreads }`, sorted by `total_weight` descending. `file` is relative, e.g.
  `spreads/rillaboom.json`.

`total_weight` and `raw_count` are what a consumer uses to decide whether a
species has enough data to trust (a usage floor is the consumer's choice).

### 4.3 `summary.json` (with `--summary`)

All species in one file, with no per-spread rows. Everything here is computed from
**all** spreads in the chaos file; `--min-share` does not apply.

Per species:

- `name`, `id`, `total_weight`
- `nature_share`: `{ [nature]: weight / total_weight }`, for natures with
  non-zero weight only. Exact, because the chaos spread list is complete (§9).
- `concentration`: `{ [nature]: { top1, top5 } }`. `top1` and `top5` are the
  weight of the 1 and 5 heaviest spreads within that nature, divided by that
  nature's total weight.
- `sp`: one block for `overall` and one per nature, `{ overall: StatBlock,
  by_nature: { [nature]: StatBlock } }`, where `StatBlock = { [stat]: Dist }`
  for `hp, atk, def, spa, spd, spe`, over **stat points**. Always present.
- `stats`: the same shape over **derived final stats**. Only with `--stats`.
- `Dist` has these fields:
  - `distribution`: `[{ value, weight, cum }]` sorted by `value` ascending. `value`
    is the integer stat points (or final stat), `weight` is the total spread
    weight producing that value, and `cum` is the cumulative weight fraction (0
    to 1). **This is the source of truth.**
  - Convenience fields: `p5, p10, p25, p50, p75, p90, p95, min, max, mean`.
  - **Percentile definition:** nearest rank on the discrete distribution. `pK` is
    the smallest `value` whose `cum ≥ K/100`, with no interpolation. `mean` is the
    weighted mean.

### 4.4 `spreads/<speciesid>.json`

The full spread layer for one species. **This is the primary output.**

- `schema_version`, `month`, `format`, `cutoff`, `name`, `id`, `total_weight`
- `min_share`: the floor applied, or `0`
- `dropped`: `{ count, weight }`, the spreads removed by the floor. The invariant
  is `kept weight + dropped.weight == total_weight`.
- `spreads`: an array sorted by `weight` descending, then `spread` ascending as a
  tiebreak. Each entry is:
  - `spread`: the original key, e.g. `"Adamant:32/32/0/0/2/0"`
  - `nature`
  - `sp`: `{ hp, atk, def, spa, spd, spe }`, stat points. **Pin-free:** true
    for the month regardless of any game-data version.
  - `weight`: the raw chaos weight
  - `share`: `weight / total_weight`
  - `stats`: `{ hp, atk, def, spa, spd, spe }`, derived final stats (§5.2).
    Only with `--stats`; tied to the manifest's `showdown_sha`.
- `by_nature`: `{ [nature]: [indices into spreads] }`, so a consumer that knows
  the nature (an open team sheet) can filter without a scan.

### 4.5 `manifest.json` (per generation)

- `schema_version`, `month`, `format`, `cutoff`, `generated_at`
- `generator`: `{ version, commit }`: this repo's package version and git SHA
  when available
- `showdown_sha`: the full pokemon-showdown commit used for derivation, or `null`
  without `--stats`
- `options`: `{ stats, summary, min_share }`
- `source`: `{ url | path, fetched_at, http_last_modified, http_etag, sha256,
  bytes }`. HTTP fields are `null` for `--raw`.
- `outputs`: for each file written, `{ path, sha256, bytes }`
- `quality`: `{ species, spreads_parsed, spreads_rejected,
  spreads_dropped_by_floor, weight_dropped_by_floor, max_rel_weight_mismatch,
  unresolved_species }`. `max_rel_weight_mismatch` is the largest relative
  difference, across species, between Σspreads and Σabilities. Any rejection
  fails the run (§5.4), so `spreads_rejected` is always 0 in a written manifest.

A consumer that records `source.sha256`, `generator.commit`, `options` and
`showdown_sha` can reproduce the outputs byte for byte (§6.5).

### 4.6 Schemas and versioning

- Every output file carries `schema_version` (semver).
- `schemas/` holds JSON Schema (draft 2020-12) files for `index`, `summary`,
  `spreads` and `manifest`. These schemas are the contract with consumers.
- A breaking change bumps the major version and is recorded in `CHANGELOG.md`.
  Consumers regenerate when they want the new version; nothing is migrated.

## 5. Derivation

### 5.1 Weights

A chaos weight is a rating-weighted team count. For a species,
`Σ Spreads = Σ Abilities = Σ Items = Σ Happiness = total_weight`, which also
equals `Raw count × Avg. weight` (the "Avg. weight" shown in the moveset header).
Shares are always normalized against that species' `total_weight`. Raw weights
are kept unchanged in the spread layer.

### 5.2 Final stats (`--stats` only)

- Use pokemon-showdown's own Champions stat calculation at the pinned SHA (§7):
  the `champions` mod's `statModify`, Level 50, without Level Clause Mod. At
  Showdown commit `9fb3a5b99f1a0bea17f495c5cc1bfe04fdd19c3e` (where it was
  verified, §9), that code is:
  - HP = `base + SP + 75`
  - Other stats = `trunc(trunc((base + SP + 20) × natureMult × 100, 16) / 100)`,
    where `natureMult` is 1.1 for the boosted stat, 0.9 for the lowered stat and 1
    otherwise (Showdown applies the nature with 16-bit truncation)
- Base stats come from the pinned Dex, resolved with the `champions` mod for the
  chaos species name, including formes and Megas.
- The implementation is a local function proven equal to Showdown by the
  acceptance test (§11.2), not a call into a running Battle (§10, D5).
- Out of scope: items, abilities, field effects and stat stages (§8).

Base stats change between game-data versions (Champions receives balance
patches), so derived stats are only meaningful together with `showdown_sha`.
Consumers with their own stat engine should recompute from `sp` at their own pin.

### 5.3 Spread parsing

Each `Nature:a/b/c/d/e/f` key must meet all of the following:

- The nature is one of the 25 natures.
- There are exactly six integers.
- Each value is between 0 and 32.
- The sum is at most 66.

Anything else is a rejection, recorded in `quality` (§5.4).

### 5.4 Failure policy

- A rejected spread fails the run.
- A weight mismatch above `1e-9` relative fails the run.
- A species name that does not resolve in the pinned Dex **fails the run with
  `--stats`** and is only **counted** (`quality.unresolved_species`) without it,
  since the core output needs no Dex. This keeps the core path usable when a new
  regulation adds species the pin does not know yet.
- The generator never falls back to `moveset/*.txt`.
- On failure nothing is written under `--out` and the exit code is non-zero.

## 6. Command line and library contract

### 6.1 Commands

```
vgc-usage-stats generate --month 2026-09 \
  --format gen9championsvgc2026regmcbo3 --cutoff 1760 \
  --out ./usage [--stats] [--summary] [--min-share 0] [--cache DIR]

vgc-usage-stats generate --raw ./chaos.json --month 2026-09 \
  --format gen9championsvgc2026regmcbo3 --cutoff 1760 --out ./usage

vgc-usage-stats list --month 2026-09 [--filter champions]
```

- `generate` is the product. It fetches (or reads `--raw`), parses, derives,
  validates against the schemas, runs the invariant checks (§11) and writes.
- `list` prints the chaos files Smogon has for a month, so a consumer can
  discover format ids and cutoffs. Read-only; it never writes to `--out`.
- Exit codes: `0` success; `2` bad arguments; `3` the month or file does not
  exist at Smogon (not an error for a month not yet published, but reported);
  `4` a fetch failed after retries; `5` a validation or invariant failure.

### 6.2 Library

The TypeScript package exports the same steps as functions, so a TypeScript
consumer need not shell out: fetch (with cache), parse, derive, summarize,
validate, write. The CLI is a thin layer over them. Python and other consumers
use the CLI and read the files.

### 6.3 Cache

Fetched raw files are stored gzipped under `--cache` as
`<month>/<format>-<cutoff>.json.gz` with a sidecar recording the URL, ETag,
Last-Modified and sha256. A later run for the same month, format and cutoff
reads the cache and does not touch the network unless `--refresh` is given. A
`--refresh` fetch that returns different bytes is reported on stderr with both
hashes, then used; the old file is kept as `.prev` until the next refresh.

### 6.4 Retries

HTTP: 3 attempts per file with exponential backoff, on 5xx responses, timeouts
and network errors. There is no outer retry; the consumer decides when to run
again.

### 6.5 Determinism and reproducibility

- The same raw bytes, generator commit, options and Showdown pin produce
  byte-identical outputs on any machine (stable key order, fixed number
  formatting, sorted arrays, no timestamps outside `manifest.json`).
- `manifest.json` is the only file with run-dependent fields (`generated_at`,
  `fetched_at`, HTTP headers). Everything a consumer needs to pin is in it.
- Reproducing an old generation needs the raw file. The cache keeps it; a
  consumer that wants insurance against Smogon changing or removing a file keeps
  its own copy of the gzipped raw and reruns with `--raw`. The generator does not
  archive anything itself (§8).

## 7. Technology

- Node `>=22.18.0` and TypeScript. Tests use `node --test`, and scripts run TS
  directly with Node's type stripping.
- `pokemon-showdown` is an npm git dependency pinned by full commit SHA:
  `github:smogon/pokemon-showdown#<sha>`, with the lockfile committed. It is
  loaded only for `--stats` and name resolution; the core path never imports it.
  The initial pin is `9fb3a5b99f1a0bea17f495c5cc1bfe04fdd19c3e`, where §5.2 was
  verified (§10, D6). Bumps are deliberate: re-verify §5.2 at the new commit,
  rerun the parity test, and record the change in `CHANGELOG.md`.
- Other runtime dependencies are kept minimal: a JSON Schema validator (e.g. Ajv)
  and nothing for HTTP beyond `fetch`.

## 8. Non-goals

- **No committed data.** The repo holds code, schemas, fixtures and docs. Outputs
  live wherever the consumer puts `--out`.
- **No scheduled job, no Releases, no archive of raw files.** The consumer runs
  the generator when it wants a month. (A manual raw-archive command may be added
  if Smogon is ever seen to change or remove a published file.)
- Not a published package (npm or PyPI) for now, and no runtime API. Consumers
  pin the repo by commit.
- No replay crawling and no data from third-party sites. Smogon `/stats/` is the
  only source.
- No effective-stat modifiers: items, abilities, field effects, stat stages.
- No moveset/leads/metagame parsing, and no items/moves/teammates outputs (for
  now).
- No consumer-specific exports (id remapping, top-N selection, usage floors).
  Those belong downstream.

## 9. Facts verified

These were checked on 2026-10-06 against `2026-09` unless noted otherwise.

- [x] `chaos/` exists for `gen9championsvgc2026regmc` and `...regmcbo3` at cutoffs
      0/1500/1630/1760 in 2026-09. Reg M-C has no other months yet.
- [x] Spread lists are complete, not truncated. In regmc-1760, Σspreads equals
      Σabilities for all 277 species (max relative difference 5.1e-13).
- [x] Weight semantics: `total_weight = Raw count × Avg. weight`. Rillaboom:
      1410840 × 0.0042599 ≈ 6009.85.
- [x] Spread values are SP: max 32 per stat and max 66 in total in regmc-1760.
- [x] Only 21 distinct natures appear in regmc-1760, so outputs must not assume
      all 25 are present.
- [x] The Champions stat formula at Showdown commit `9fb3a5b` is as stated in
      §5.2 (`data/mods/champions/scripts.ts`).
- [x] Raw chaos sizes for 2026-09, as gzipped size (the server's ETag) and
      uncompressed size:
  - regmc: 0 = 3.5 MB, 1500 = 7.3 MB, 1630 = 6.3 MB, 1760 = 5.9 MB gzipped
    (16.2 MB uncompressed). 1500 is 18.7 MB uncompressed.
  - regmcbo3: 0 = 1.2 MB, 1500 = 2.6 MB, 1630 = 2.1 MB, 1760 = 2.0 MB gzipped.
  - A full month of both formats is about 30 MB gzipped in the cache.
- [x] 63% of spreads (195k of 309k) in regmc-1760 have weight < 0.001.

### 9.1 Facts to verify during implementation

- [ ] Reg M-C VGC formats do **not** include Level Clause Mod, so the non-level
      branch of `statModify` applies. Check the `Flat Rules` expansion at the
      pinned SHA.
- [ ] Every chaos species name (Megas, regional formes, `Indeedee-F`, etc.)
      resolves in the pinned Dex under the `champions` mod.
- [ ] Parse and write time for regmc-1500 (the largest file) with no floor, and
      the size of its output directory, so consumers know what a run costs.
- [ ] Whether Smogon's server honours `If-None-Match` for chaos files, so
      `--refresh` can be cheap.

## 10. Decisions

Resolved with the 2026-10-13 revision; kept here for the record.

- **D1 — Missing chaos file:** fail with exit code 3, never fall back to `.txt`.
- **D2 — Weight floor:** none by default. `--min-share` is a share of the
  species' total weight, not an absolute weight, so rare species keep their
  spreads; the floor and what it dropped are recorded in every spreads file.
- **D3 — `nature_share` keys:** natures with non-zero weight only.
- **D4 — Republished source:** no longer a pipeline question. The cache keeps
  what was fetched; `--refresh` reports a changed file and the manifest's source
  hash lets a consumer notice.
- **D5 — Stat function:** a local implementation of §5.2, proven by the §11.2
  test against Showdown. Simpler than building a Battle to read stats from.
- **D6 — Initial Showdown pin:** `9fb3a5b`, where §5.2 was verified.
- **D7 — Generator, not dataset** (2026-10-13): see §12.
- **D8 — Showdown is optional at runtime:** the core output is stat points,
  which need no game data. The pin is loaded only for `--stats`.

## 11. Acceptance criteria

All of these are automated tests that run in CI on every push.

1. **Fixture parse.** A trimmed chaos fixture (`test/fixtures/`, a few species
   with a handful of spreads, including an invalid one) parses to a committed,
   hand-checked table of `{ species, nature, sp, weight, share }`, and the invalid
   spread is rejected.
2. **Derived stats match Showdown.** For a fixed sample of spreads, at least one
   per stat and including a boosted and a lowered stat for several species, a
   Mega and a forme, the derived stats equal what pokemon-showdown computes at the
   pinned SHA. The test builds a Champions Reg M-C team and reads the stats
   Showdown reports.
3. **Byte-identical rerun.** Generating twice from the same raw file into two
   directories produces identical files, `manifest.json` excepted, and the
   manifests differ only in `generated_at` and fetch fields.
4. **Offline equals online.** Generating with `--raw` on the cached file equals
   generating from the URL.
5. **Normalization invariants**, within `1e-9`:
   - `Σ nature_share = 1`.
   - Every `distribution` ends at `cum = 1`.
   - Percentiles are monotonic (`min ≤ p5 ≤ … ≤ p95 ≤ max`).
   - `kept + dropped weight = total_weight`.
   - Σspreads = Σabilities for every species.
   - `by_nature` indices partition `spreads`.
6. **JSON Schema validation.** Every file written validates against `schemas/`
   for its `schema_version`.
7. **Manifest integrity.** Every file listed in `outputs` exists with a matching
   sha256 and size, and `source.sha256` matches the raw file.
8. **Percentile definition.** A small synthetic distribution checks nearest-rank
   percentiles against hand-computed values.
9. **Failure leaves no output.** A run that fails validation writes nothing under
   `--out` and exits non-zero.

## 12. Why a generator (2026-10-13)

The 2026-10-06 draft committed derived data monthly from a scheduled workflow and
archived raw files on GitHub Releases. That was replaced because:

- **The data is big and grows.** A no-floor spread layer is tens of MB per
  format × cutoff per month. Anyone pinning the repo by commit would carry all of
  it forever, and the weight-floor decision was being forced by git size rather
  than by what consumers need.
- **Consumers lock their own derivative anyway.** A set-inference tool keeps a
  small locked file in its own tree with the source hash and generator commit.
  Committing the full output here duplicated that with worse economics.
- **Scope.** Scheduling, Releases, idempotency, issue automation and the
  republished-source policy were most of the operational surface and none of the
  value. The generator keeps fetch, parse, derive, validate and write.
- **Any month on demand.** Older regulations and other formats need no ingestion
  decision or registry entry.
- **Licensing hygiene.** The public repo redistributes code, not bulk derived
  Smogon data.

What was given up: a guaranteed replay of old months if Smogon changes or removes
a file. The cache and `--raw` cover the common case; a raw-archive command is the
documented fallback if it is ever needed (§8).
