// Build the output objects of SPEC §4 from parsed data. Pure; key order here is the key order on disk.

import { type ChaosFile, type SpeciesData, type StatBlock } from "./parse.ts";
import { summarizeSpecies, type SpeciesSummary } from "./summary.ts";
import { SCHEMA_VERSION } from "./validate.ts";

export interface Target {
  month: string;
  format: string;
  cutoff: number;
}

export interface SpreadsFile {
  schema_version: string;
  month: string;
  format: string;
  cutoff: number;
  name: string;
  id: string;
  total_weight: number;
  min_share: number;
  dropped: { count: number; weight: number };
  spreads: SpreadRow[];
  by_nature: Record<string, number[]>;
}

export interface SpreadRow {
  spread: string;
  nature: string;
  sp: StatBlock;
  weight: number;
  share: number;
  stats?: StatBlock;
}

export interface IndexFile {
  schema_version: string;
  month: string;
  format: string;
  cutoff: number;
  source: { url: string | null; path: string | null; sha256: string; bytes: number };
  info: Record<string, unknown>;
  species: { name: string; id: string; file: string; total_weight: number; raw_count: number; usage: number; n_spreads: number }[];
}

export interface SummaryFile {
  schema_version: string;
  month: string;
  format: string;
  cutoff: number;
  species: SpeciesSummary[];
}

export function speciesFile(species: SpeciesData): string {
  return `spreads/${species.id}.json`;
}

/**
 * The spreads file for one species. `stats` is parallel to `species.spreads` when derived stats
 * are wanted. Spreads with share < minShare are dropped and accounted for in `dropped`.
 */
export function buildSpreadsFile(target: Target, species: SpeciesData, minShare: number, stats?: StatBlock[]): SpreadsFile {
  const total = species.total_weight;
  const rows: SpreadRow[] = [];
  const by_nature: Record<string, number[]> = {};
  let droppedCount = 0;
  let droppedWeight = 0;

  species.spreads.forEach((s, i) => {
    const share = total > 0 ? s.weight / total : 0;
    if (share < minShare) {
      droppedCount++;
      droppedWeight += s.weight;
      return;
    }
    const row: SpreadRow = { spread: s.spread, nature: s.nature, sp: s.sp, weight: s.weight, share };
    if (stats) row.stats = stats[i]!;
    (by_nature[s.nature] ??= []).push(rows.length);
    rows.push(row);
  });

  const sortedByNature: Record<string, number[]> = {};
  for (const nature of Object.keys(by_nature).sort()) sortedByNature[nature] = by_nature[nature]!;

  return {
    schema_version: SCHEMA_VERSION,
    month: target.month,
    format: target.format,
    cutoff: target.cutoff,
    name: species.name,
    id: species.id,
    total_weight: total,
    min_share: minShare,
    dropped: { count: droppedCount, weight: droppedWeight },
    spreads: rows,
    by_nature: sortedByNature,
  };
}

export function buildIndexFile(
  target: Target,
  chaos: ChaosFile,
  source: IndexFile["source"],
  spreadsFiles: SpreadsFile[],
): IndexFile {
  return {
    schema_version: SCHEMA_VERSION,
    month: target.month,
    format: target.format,
    cutoff: target.cutoff,
    source,
    info: chaos.info,
    species: chaos.species.map((s, i) => ({
      name: s.name,
      id: s.id,
      file: speciesFile(s),
      total_weight: s.total_weight,
      raw_count: s.raw_count,
      usage: s.usage,
      n_spreads: spreadsFiles[i]!.spreads.length,
    })),
  };
}

export function buildSummaryFile(target: Target, chaos: ChaosFile, stats?: StatBlock[][]): SummaryFile {
  return {
    schema_version: SCHEMA_VERSION,
    month: target.month,
    format: target.format,
    cutoff: target.cutoff,
    species: chaos.species.map((s, i) => summarizeSpecies(s, stats?.[i])),
  };
}
