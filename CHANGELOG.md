# Changelog

## 0.1.0 (2026-10-13)

First working generator, implementing `docs/SPEC.md` (2026-10-13 revision).

- `generate`: fetch (or `--raw`), parse, derive, validate and write
  `manifest.json`, `index.json`, `spreads/<speciesid>.json` and, with
  `--summary`, `summary.json`. Output schema version `1.0.0`.
- `list`: the chaos files Smogon has for a month.
- Gzipped cache with sidecar, `--refresh` with `If-None-Match`, 3 fetch attempts.
- `--stats` derives Champions final stats with pokemon-showdown pinned at
  `9fb3a5b99f1a0bea17f495c5cc1bfe04fdd19c3e`, proven against a real Battle.
- `--min-share` floor with dropped accounting.
- All nine acceptance tests from the spec run under `node --test`.
