// Per-species summaries (SPEC §4.3): nature share, concentration and stat distributions.
// Pure. Works over stat points, and over derived final stats when they are supplied.
// Everything is computed from all spreads; `--min-share` never applies here.
// Zero-weight spreads contribute nothing: they are left out of distributions and nature lists (D3).

import { STATS, type SpeciesData, type StatBlock, type StatName } from "./parse.ts";

export interface DistEntry {
  value: number;
  weight: number;
  cum: number;
}

export interface Dist {
  distribution: DistEntry[];
  p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number;
  min: number;
  max: number;
  mean: number;
}

export type StatDists = Record<StatName, Dist>;

export interface SpeciesSummary {
  name: string;
  id: string;
  total_weight: number;
  nature_share: Record<string, number>;
  concentration: Record<string, { top1: number; top5: number }>;
  sp: { overall: StatDists; by_nature: Record<string, StatDists> };
  stats?: { overall: StatDists; by_nature: Record<string, StatDists> };
}

export const PERCENTILES = [5, 10, 25, 50, 75, 90, 95] as const;

/**
 * Build a weighted discrete distribution. Values with zero total weight are dropped.
 * `cum` is the cumulative weight fraction; the last entry is exactly 1.
 * Percentiles use nearest rank: pK is the smallest value whose cum >= K/100.
 */
export function buildDist(pairs: Iterable<readonly [value: number, weight: number]>): Dist {
  const byValue = new Map<number, number>();
  for (const [value, weight] of pairs) byValue.set(value, (byValue.get(value) ?? 0) + weight);
  const values = [...byValue.keys()].filter((v) => byValue.get(v)! > 0).sort((a, b) => a - b);
  if (values.length === 0) throw new Error("cannot build a distribution with no weight");

  let total = 0;
  for (const v of values) total += byValue.get(v)!;

  const distribution: DistEntry[] = [];
  let running = 0;
  let weightedSum = 0;
  for (const value of values) {
    const weight = byValue.get(value)!;
    running += weight;
    weightedSum += value * weight;
    distribution.push({ value, weight, cum: running / total });
  }
  distribution[distribution.length - 1]!.cum = 1;

  const percentile = (k: number): number => distribution.find((e) => e.cum >= k / 100)!.value;
  return {
    distribution,
    p5: percentile(5), p10: percentile(10), p25: percentile(25), p50: percentile(50),
    p75: percentile(75), p90: percentile(90), p95: percentile(95),
    min: values[0]!,
    max: values[values.length - 1]!,
    mean: weightedSum / total,
  };
}

function statDists(rows: { block: StatBlock; weight: number }[]): StatDists {
  const out = {} as StatDists;
  for (const stat of STATS) out[stat] = buildDist(rows.map((r) => [r.block[stat], r.weight] as const));
  return out;
}

function sortedNatures(natureWeight: Map<string, number>): string[] {
  return [...natureWeight.keys()].sort();
}

/**
 * Summarize one species. `stats`, when given, is parallel to `species.spreads` and holds
 * the derived final stats for each spread; it produces the `stats` block.
 */
export function summarizeSpecies(species: SpeciesData, stats?: StatBlock[]): SpeciesSummary {
  if (stats && stats.length !== species.spreads.length) throw new Error("stats must be parallel to spreads");
  if (!(species.total_weight > 0)) throw new Error(`${species.name} has no weight`);
  const total = species.total_weight;

  // Nature totals over non-zero-weight spreads only.
  const natureWeight = new Map<string, number>();
  for (const s of species.spreads) {
    if (s.weight <= 0) continue;
    natureWeight.set(s.nature, (natureWeight.get(s.nature) ?? 0) + s.weight);
  }
  const natures = sortedNatures(natureWeight);

  const nature_share: Record<string, number> = {};
  const concentration: SpeciesSummary["concentration"] = {};
  for (const nature of natures) {
    const nw = natureWeight.get(nature)!;
    nature_share[nature] = nw / total;
    // spreads are already sorted by weight descending
    const weights = species.spreads.filter((s) => s.nature === nature && s.weight > 0).map((s) => s.weight);
    const top = (n: number) => weights.slice(0, n).reduce((a, b) => a + b, 0) / nw;
    concentration[nature] = { top1: top(1), top5: top(5) };
  }

  const block = (pick: (i: number) => StatBlock) => {
    const rows = species.spreads.map((s, i) => ({ block: pick(i), weight: s.weight, nature: s.nature }));
    const by_nature: Record<string, StatDists> = {};
    for (const nature of natures) by_nature[nature] = statDists(rows.filter((r) => r.nature === nature));
    return { overall: statDists(rows), by_nature };
  };

  const summary: SpeciesSummary = {
    name: species.name,
    id: species.id,
    total_weight: total,
    nature_share,
    concentration,
    sp: block((i) => species.spreads[i]!.sp),
  };
  if (stats) summary.stats = block((i) => stats[i]!);
  return summary;
}
