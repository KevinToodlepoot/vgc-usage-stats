// Derived final stats with the pinned pokemon-showdown (SPEC §5.2, D5, D8).
// The formula is a local function; the acceptance test proves it equal to what a Showdown Battle
// reports at the pin. Showdown itself is loaded only here, and only on demand, for base stats and
// name resolution.

import { readFileSync } from "node:fs";
import { ValidationError } from "./errors.ts";
import type { StatsDeriver } from "./generate.ts";
import { NATURES, STATS, type StatBlock } from "./parse.ts";

/** Showdown's `trunc`: unsigned 32-bit, or modulo 2^bits when `bits` is given. */
function trunc(num: number, bits = 0): number {
  if (bits) return (num >>> 0) % 2 ** bits;
  return num >>> 0;
}

/**
 * The Champions stat calculation at Level 50 without Level Clause Mod
 * (`data/mods/champions/scripts.ts` statModify at the pinned commit):
 *   HP     = base + SP + 75
 *   others = trunc(trunc((base + SP + 20) × 110 or 90, 16) / 100), or base + SP + 20 for a neutral stat
 */
export function championsStats(base: StatBlock, nature: string, sp: StatBlock): StatBlock {
  const n = NATURES[nature];
  if (!n) throw new ValidationError(`unknown nature '${nature}'`);
  const out = {} as StatBlock;
  for (const stat of STATS) {
    if (stat === "hp") {
      out.hp = base.hp + sp.hp + 75;
      continue;
    }
    let value = base[stat] + sp[stat] + 20;
    if (n.plus === stat) value = trunc(trunc(value * 110, 16) / 100);
    else if (n.minus === stat) value = trunc(trunc(value * 90, 16) / 100);
    out[stat] = value;
  }
  return out;
}

/** The full commit SHA of the pokemon-showdown dependency, read from this package's package.json. */
export function pinnedShowdownSha(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const spec: string = pkg.dependencies["pokemon-showdown"];
  const m = /#([0-9a-f]{40})$/.exec(spec);
  if (!m) throw new Error(`pokemon-showdown is not pinned by full commit SHA: ${spec}`);
  return m[1]!;
}

interface ShowdownDex {
  mod(name: string): ShowdownDex;
  species: { get(name: string): { exists: boolean; name: string; baseStats: StatBlock } };
  formats: {
    get(name: string): { exists: boolean; mod: string };
    getRuleTable(format: unknown): { has(rule: string): boolean };
  };
}

export const CHAMPIONS_MOD = "champions";

/**
 * Load the pinned Showdown and return a deriver for the `champions` mod.
 * When `format` is known to the pin it must be a Champions format without Level Clause Mod; an
 * unknown format (for example a regulation the pin no longer lists) is accepted with a warning.
 */
export async function loadStatsDeriver(format?: string, log: (line: string) => void = () => {}): Promise<StatsDeriver> {
  const mod = await import("pokemon-showdown");
  const Dex = (mod.Dex ?? (mod as { default?: { Dex?: ShowdownDex } }).default?.Dex) as ShowdownDex | undefined;
  if (!Dex) throw new Error("pokemon-showdown did not export Dex; was it built? (see postinstall)");

  if (format) {
    const f = Dex.formats.get(format);
    if (f.exists) {
      if (f.mod !== CHAMPIONS_MOD) throw new ValidationError(`--stats needs a Champions format; ${format} uses mod '${f.mod}'`);
      if (Dex.formats.getRuleTable(f).has("levelclausemod")) throw new ValidationError(`--stats does not support Level Clause Mod (${format})`);
    } else {
      log(`warning: ${format} is not a format at the pinned Showdown; deriving stats with the '${CHAMPIONS_MOD}' mod anyway`);
    }
  }

  const dex = Dex.mod(CHAMPIONS_MOD);
  const baseStats = new Map<string, StatBlock | null>();
  const lookup = (name: string): StatBlock | null => {
    let base = baseStats.get(name);
    if (base === undefined) {
      const species = dex.species.get(name);
      base = species.exists ? { ...species.baseStats } : null;
      baseStats.set(name, base);
    }
    return base;
  };

  return {
    showdownSha: pinnedShowdownSha(),
    derive(speciesName, nature, sp) {
      const base = lookup(speciesName);
      return base ? championsStats(base, nature, sp) : null;
    },
  };
}
