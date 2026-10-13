// The pipeline for one format × cutoff × month (SPEC §4, §5.4, §6.5):
// parse -> failure policy -> build outputs -> validate -> write atomically.

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "./errors.ts";
import { parseChaos, ParseError, type ChaosFile, type StatBlock } from "./parse.ts";
import { buildIndexFile, buildSpreadsFile, buildSummaryFile, speciesFile, type Target } from "./outputs.ts";
import { SCHEMA_VERSION, validate, type OutputKind } from "./validate.ts";

export const MAX_REL_WEIGHT_MISMATCH = 1e-9;

export interface SourceInfo {
  url: string | null;
  path: string | null;
  fetched_at: string | null;
  http_last_modified: string | null;
  http_etag: string | null;
}

/** Supplied only with `--stats`. `derive` returns null for a species the Dex does not know. */
export interface StatsDeriver {
  showdownSha: string;
  derive(speciesName: string, nature: string, sp: StatBlock): StatBlock | null;
}

export interface GenerateOptions {
  target: Target;
  raw: Uint8Array;
  source: SourceInfo;
  out: string;
  summary?: boolean;
  minShare?: number;
  stats?: StatsDeriver;
  /** Overrides for reproducible tests. */
  now?: () => Date;
  generatorCommit?: string | null;
}

export interface Manifest {
  schema_version: string;
  month: string;
  format: string;
  cutoff: number;
  generated_at: string;
  generator: { version: string; commit: string | null };
  showdown_sha: string | null;
  options: { stats: boolean; summary: boolean; min_share: number };
  source: SourceInfo & { sha256: string; bytes: number };
  outputs: { path: string; sha256: string; bytes: number }[];
  quality: {
    species: number;
    spreads_parsed: number;
    spreads_rejected: number;
    spreads_dropped_by_floor: number;
    weight_dropped_by_floor: number;
    max_rel_weight_mismatch: number;
    unresolved_species: string[];
  };
}

export interface GenerateResult {
  /** The directory written: `<out>/<month>/<format>-<cutoff>`. */
  dir: string;
  manifest: Manifest;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function targetDirName(target: Target): string {
  return `${target.format}-${target.cutoff}`;
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export function generatorVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
}

export function generatorCommit(): string | null {
  try {
    const sha = execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Parse and apply the §5.4 failure policy. Exported for tests and for `--raw` dry runs. */
export function parseAndCheck(raw: Uint8Array): ChaosFile {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch (e) {
    throw new ValidationError(`raw file is not valid JSON: ${(e as Error).message}`);
  }
  let chaos: ChaosFile;
  try {
    chaos = parseChaos(json);
  } catch (e) {
    if (e instanceof ParseError) throw new ValidationError(`raw file is not a chaos file: ${e.message}`);
    throw e;
  }
  const rejected = chaos.species.flatMap((s) => s.rejected);
  if (rejected.length > 0) {
    const shown = rejected.slice(0, 5).map((r) => `${r.species} '${r.spread}' (${r.reason})`).join("; ");
    throw new ValidationError(`${rejected.length} spread(s) rejected: ${shown}${rejected.length > 5 ? "; ..." : ""}`);
  }
  for (const s of chaos.species) {
    if (!(s.rel_weight_mismatch <= MAX_REL_WEIGHT_MISMATCH)) {
      throw new ValidationError(`${s.name}: Σspreads (${s.total_weight}) and Σabilities (${s.abilities_weight}) differ by ${s.rel_weight_mismatch} relative`);
    }
  }
  return chaos;
}

/** Fixed serialization: compact for the large files, indented for the small ones. Always ends in a newline. */
function serialize(kind: OutputKind, obj: unknown): string {
  return (kind === "index" || kind === "manifest" ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)) + "\n";
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const { target, raw, out } = opts;
  const minShare = opts.minShare ?? 0;
  const wantSummary = opts.summary ?? false;
  if (!(minShare >= 0 && minShare <= 1)) throw new ValidationError(`min_share must be between 0 and 1, got ${minShare}`);

  const chaos = parseAndCheck(raw);

  // Derived stats (parallel to each species' spreads) when requested.
  let stats: StatBlock[][] | undefined;
  const unresolved: string[] = [];
  if (opts.stats) {
    stats = [];
    for (const s of chaos.species) {
      const blocks: StatBlock[] = [];
      for (const sp of s.spreads) {
        const derived = opts.stats.derive(s.name, sp.nature, sp.sp);
        if (!derived) { unresolved.push(s.name); break; }
        blocks.push(derived);
      }
      stats.push(blocks);
    }
    if (unresolved.length > 0) {
      throw new ValidationError(`${unresolved.length} species not in the pinned Dex: ${unresolved.join(", ")}`);
    }
  }

  // Build and validate every object before anything touches the disk.
  const files: { path: string; kind: OutputKind; text: string }[] = [];
  const spreadsFiles = chaos.species.map((s, i) => buildSpreadsFile(target, s, minShare, stats?.[i]));
  spreadsFiles.forEach((f, i) => {
    validate("spreads", f, speciesFile(chaos.species[i]!));
    files.push({ path: speciesFile(chaos.species[i]!), kind: "spreads", text: serialize("spreads", f) });
  });
  const index = buildIndexFile(target, chaos, { url: opts.source.url, path: opts.source.path, sha256: sha256(raw), bytes: raw.byteLength }, spreadsFiles);
  validate("index", index);
  files.unshift({ path: "index.json", kind: "index", text: serialize("index", index) });
  if (wantSummary) {
    const summary = buildSummaryFile(target, chaos, stats);
    validate("summary", summary);
    files.splice(1, 0, { path: "summary.json", kind: "summary", text: serialize("summary", summary) });
  }

  let droppedCount = 0;
  let droppedWeight = 0;
  for (const f of spreadsFiles) { droppedCount += f.dropped.count; droppedWeight += f.dropped.weight; }

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    month: target.month,
    format: target.format,
    cutoff: target.cutoff,
    generated_at: (opts.now ?? (() => new Date()))().toISOString(),
    generator: { version: generatorVersion(), commit: opts.generatorCommit === undefined ? generatorCommit() : opts.generatorCommit },
    showdown_sha: opts.stats?.showdownSha ?? null,
    options: { stats: Boolean(opts.stats), summary: wantSummary, min_share: minShare },
    source: { ...opts.source, sha256: sha256(raw), bytes: raw.byteLength },
    outputs: files.map((f) => ({ path: f.path, sha256: sha256(f.text), bytes: Buffer.byteLength(f.text) })),
    quality: {
      species: chaos.species.length,
      spreads_parsed: chaos.species.reduce((a, s) => a + s.spreads.length, 0),
      spreads_rejected: 0,
      spreads_dropped_by_floor: droppedCount,
      weight_dropped_by_floor: droppedWeight,
      max_rel_weight_mismatch: Math.max(0, ...chaos.species.map((s) => s.rel_weight_mismatch)),
      unresolved_species: unresolved,
    },
  };
  validate("manifest", manifest);
  files.push({ path: "manifest.json", kind: "manifest", text: serialize("manifest", manifest) });

  // Write to a temporary sibling, then move into place (§4.1).
  const monthDir = join(out, target.month);
  const finalDir = join(monthDir, targetDirName(target));
  const tmpDir = join(monthDir, `.${targetDirName(target)}.tmp-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(tmpDir, "spreads"), { recursive: true });
  try {
    for (const f of files) writeFileSync(join(tmpDir, f.path), f.text);
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(tmpDir, finalDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { dir: finalDir, manifest };
}
