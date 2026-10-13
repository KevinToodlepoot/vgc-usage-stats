// Command line (SPEC §6.1). A thin layer over the library functions.

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { GeneratorError, UsageError } from "./errors.ts";
import { generate, type StatsDeriver } from "./generate.ts";
import { DEFAULT_CACHE_DIR, fetchChaos, listChaos, readRaw } from "./smogon.ts";
import type { Target } from "./outputs.ts";

const USAGE = `usage:
  vgc-usage-stats generate --month YYYY-MM --format ID [--format ID ...] --cutoff N [--cutoff N ...] --out DIR
                           [--raw FILE] [--cache DIR] [--refresh] [--stats] [--summary] [--min-share X]
  vgc-usage-stats list --month YYYY-MM [--filter TEXT]

exit codes: 0 ok, 2 bad arguments, 3 not found at Smogon, 4 fetch failed, 5 validation failed`;

const MONTH_RE = /^\d{4}-\d{2}$/;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      month: { type: "string" },
      format: { type: "string", multiple: true },
      cutoff: { type: "string", multiple: true },
      raw: { type: "string" },
      out: { type: "string" },
      cache: { type: "string" },
      refresh: { type: "boolean", default: false },
      stats: { type: "boolean", default: false },
      summary: { type: "boolean", default: false },
      "min-share": { type: "string", default: "0" },
      filter: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function requireMonth(month: string | undefined): string {
  if (!month || !MONTH_RE.test(month)) throw new UsageError("--month YYYY-MM is required");
  return month;
}

async function runGenerate(v: ReturnType<typeof parse>["values"], log: (s: string) => void): Promise<void> {
  const month = requireMonth(v.month);
  if (!v.format?.length) throw new UsageError("--format is required");
  if (!v.cutoff?.length) throw new UsageError("--cutoff is required");
  if (!v.out) throw new UsageError("--out DIR is required");
  const cutoffs = v.cutoff.map((c) => {
    if (!/^\d+$/.test(c)) throw new UsageError(`--cutoff must be an integer, got '${c}'`);
    return Number(c);
  });
  const minShare = Number(v["min-share"]);
  if (!(minShare >= 0 && minShare <= 1)) throw new UsageError(`--min-share must be between 0 and 1, got '${v["min-share"]}'`);
  if (v.raw && (v.format.length !== 1 || cutoffs.length !== 1)) throw new UsageError("--raw takes exactly one --format and one --cutoff");

  let stats: StatsDeriver | undefined;
  if (v.stats) {
    if (v.format.length !== 1) throw new UsageError("--stats takes one --format per invocation");
    const { loadStatsDeriver } = await import("./stats.ts");
    stats = await loadStatsDeriver(v.format[0], log);
    log(`stats: pokemon-showdown ${stats.showdownSha}`);
  }

  for (const format of v.format) {
    for (const cutoff of cutoffs) {
      const target: Target = { month, format, cutoff };
      const label = `${month} ${format}-${cutoff}`;
      const { bytes, source, ...rest } = v.raw
        ? readRaw(v.raw)
        : await fetchChaos(target, { cacheDir: v.cache ?? DEFAULT_CACHE_DIR, refresh: v.refresh, log });
      log(`${label}: ${v.raw ? `read ${v.raw}` : "fromCache" in rest && rest.fromCache ? "using cached file" : "fetched"} (${bytes.byteLength} bytes)`);
      const result = await generate({ target, raw: bytes, source, out: resolve(v.out), summary: v.summary, minShare, stats });
      const q = result.manifest.quality;
      log(`${label}: wrote ${result.dir} (${q.species} species, ${q.spreads_parsed} spreads, ${q.spreads_dropped_by_floor} dropped by floor)`);
    }
  }
}

async function runList(v: ReturnType<typeof parse>["values"], out: (s: string) => void): Promise<void> {
  const month = requireMonth(v.month);
  const files = await listChaos(month, { filter: v.filter });
  for (const f of files) out(`${f.format}\t${f.cutoff}\t${f.url}`);
}

export async function main(
  argv: string[],
  io: { stdout?: (s: string) => void; stderr?: (s: string) => void } = {},
): Promise<number> {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s + "\n"));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s + "\n"));
  try {
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(argv);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const [command] = parsed.positionals;
    if (parsed.values.help || !command) {
      stdout(USAGE);
      return parsed.values.help ? 0 : 2;
    }
    if (command === "generate") await runGenerate(parsed.values, stderr);
    else if (command === "list") await runList(parsed.values, stdout);
    else throw new UsageError(`unknown command '${command}'`);
    return 0;
  } catch (e) {
    if (e instanceof GeneratorError) {
      stderr(`error: ${e.message}`);
      if (e.exitCode === 2) stderr(USAGE);
      return e.exitCode;
    }
    throw e;
  }
}
